
using System.Net;
using Amazon.APIGateway;
using Amazon.APIGateway.Model;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Functions;

public class KeyGenFunction
{
    private ILambdaLogger? logger;

    public async Task<APIGatewayHttpApiV2ProxyResponse> FunctionHandler(APIGatewayHttpApiV2ProxyRequest apigProxyEvent,
       ILambdaContext context)
    {
        logger = context.Logger;
        var secretHash = Environment.GetEnvironmentVariable("SECRET_HASH");
        var restApiId = Environment.GetEnvironmentVariable("RestApiId");
        var usagePlanId = Environment.GetEnvironmentVariable("UsagePlanId");

        var email = apigProxyEvent.QueryStringParameters["email"];
        var hash = apigProxyEvent.QueryStringParameters["hash"];
        logger.LogInformation("KeyGenController.Get called for email: " + email);

        if (hash != secretHash)
        {
            logger.LogInformation("Invalid hash: " + hash);
            return ApiResponse.CreateResponseMessage(HttpStatusCode.Unauthorized, "Invalid hash");
        }

        var key = AesOperation.EncryptString(hash, email);
        var amazonAPIGatewayClient = new AmazonAPIGatewayClient();
        string? apiKeyId = null;
        string? apiKeyValue = null;

        try
        {
            // First, check if a key with this name already exists in our usage plan
            var existingKeys = await amazonAPIGatewayClient.GetApiKeysAsync(new GetApiKeysRequest
            {
                NameQuery = email,
                IncludeValues = true
            });

            // Check if any of the keys with this name are associated with our usage plan
            ApiKey? existingKey = null;
            foreach (var apiKey in existingKeys.Items.Where(k => k.Name == email))
            {
                try
                {
                    var usagePlanKey = await amazonAPIGatewayClient.GetUsagePlanKeyAsync(new GetUsagePlanKeyRequest
                    {
                        UsagePlanId = usagePlanId,
                        KeyId = apiKey.Id
                    });
                    
                    if (usagePlanKey != null)
                    {
                        existingKey = apiKey;
                        logger.LogInformation($"Found existing key for email {email} in usage plan {usagePlanId}");
                        break;
                    }
                }
                catch (NotFoundException)
                {
                    // This key is not associated with our usage plan, continue checking
                    logger.LogInformation($"Key {apiKey.Id} is not associated with usage plan {usagePlanId}");
                    continue;
                }
            }
            
            if (existingKey != null)
            {
                logger.LogInformation($"Key already exists for email: {email}, ID: {existingKey.Id}");
                apiKeyId = existingKey.Id;
                apiKeyValue = existingKey.Value;
                logger.LogInformation($"Retrieved existing key value: {apiKeyValue}");
            }
            else
            {
                // Create the API key - API Gateway will generate the key value
                var response = await amazonAPIGatewayClient.CreateApiKeyAsync(new CreateApiKeyRequest
                {
                    Enabled = true,
                    Name = email,
                    Value = key,  // Request specific value (encrypted email)
                    StageKeys =
                    [
                        new() {
                            RestApiId = restApiId,
                            StageName = "Prod"
                        }
                    ]
                });
                apiKeyId = response.Id;
                apiKeyValue = response.Value;
                logger.LogInformation($"Key created for email: {email}, ID: {apiKeyId}");
                logger.LogInformation($"API Gateway returned key value: {apiKeyValue}");
                logger.LogInformation($"Requested key value was: {key}");
            }

            // Ensure the key is associated with the usage plan
            try
            {
                var usagePlanKeyResponse = await amazonAPIGatewayClient.CreateUsagePlanKeyAsync(new CreateUsagePlanKeyRequest
                {
                    KeyId = apiKeyId,
                    KeyType = "API_KEY",
                    UsagePlanId = usagePlanId
                });
                logger.LogInformation($"Key associated with usage plan: {usagePlanKeyResponse.Value}");
            }
            catch (ConflictException)
            {
                // Key is already associated with the usage plan, which is fine
                logger.LogInformation($"Key {apiKeyId} already associated with usage plan {usagePlanId}");
            }
        }
        catch (ConflictException ex)
        {
            logger.LogInformation($"Conflict exception: {ex.Message}");
        }
        catch (Exception ex)
        {
            logger.LogError($"Error creating/associating API key: {ex.Message}");
            
            // If we created a key but failed to associate it with the usage plan, try to clean up
            if (apiKeyId != null)
            {
                try
                {
                    await amazonAPIGatewayClient.DeleteApiKeyAsync(new DeleteApiKeyRequest { ApiKey = apiKeyId });
                    logger.LogInformation($"Rolled back: Deleted orphaned API key {apiKeyId}");
                }
                catch (Exception rollbackEx)
                {
                    logger.LogError($"Failed to rollback API key {apiKeyId}: {rollbackEx.Message}");
                }
            }
            
            return ApiResponse.CreateResponseMessage(HttpStatusCode.InternalServerError, 
                "Failed to create API key. Please try again.");
        }

        // Store the API key -> email mapping in the lookup table
        try
        {
            var apiKeyHelper = new ApiKeyHelper(logger);
            await StoreApiKeyInLookupTable(apiKeyValue!, email);
            logger.LogInformation($"Stored API key mapping in lookup table");
        }
        catch (Exception ex)
        {
            logger.LogWarning($"Failed to store API key in lookup table (non-critical): {ex.Message}");
        }

        // Return the actual API key value from API Gateway, not the encrypted email
        logger.LogInformation($"Returning API key value: {apiKeyValue}");
        return new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = (int)HttpStatusCode.OK,
            Body = apiKeyValue ?? key  // Fallback to encrypted key if somehow value is null
        };
    }

    private async Task StoreApiKeyInLookupTable(string apiKey, string email)
    {
        var lookupTableName = Environment.GetEnvironmentVariable("API_KEY_LOOKUP_TABLE");
        if (string.IsNullOrEmpty(lookupTableName))
        {
            logger?.LogWarning("API_KEY_LOOKUP_TABLE environment variable not set");
            return;
        }

        var dynamoClient = new Amazon.DynamoDBv2.AmazonDynamoDBClient();
        var putRequest = new Amazon.DynamoDBv2.Model.PutItemRequest
        {
            TableName = lookupTableName,
            Item = new Dictionary<string, Amazon.DynamoDBv2.Model.AttributeValue>
            {
                { "ApiKey", new Amazon.DynamoDBv2.Model.AttributeValue { S = apiKey } },
                { "Email", new Amazon.DynamoDBv2.Model.AttributeValue { S = email } },
                { "CreatedAt", new Amazon.DynamoDBv2.Model.AttributeValue { S = DateTime.UtcNow.ToString("o") } }
            }
        };

        await dynamoClient.PutItemAsync(putRequest);
    }
}
