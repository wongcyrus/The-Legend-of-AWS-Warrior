
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

        try
        {
            // First, check if a key with this name already exists
            var existingKeys = await amazonAPIGatewayClient.GetApiKeysAsync(new GetApiKeysRequest
            {
                NameQuery = email,
                IncludeValues = false
            });

            var existingKey = existingKeys.Items.FirstOrDefault(k => k.Name == email);
            
            if (existingKey != null)
            {
                logger.LogInformation($"Key already exists for email: {email}, ID: {existingKey.Id}");
                apiKeyId = existingKey.Id;
            }
            else
            {
                // Create the API key
                var response = await amazonAPIGatewayClient.CreateApiKeyAsync(new CreateApiKeyRequest
                {
                    Enabled = true,
                    Name = email,
                    Value = key,
                    StageKeys =
                    [
                        new() {
                            RestApiId = restApiId,
                            StageName = "Prod"
                        }
                    ]
                });
                apiKeyId = response.Id;
                logger.LogInformation($"Key created for email: {email}, ID: {apiKeyId}");
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

        return new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = (int)HttpStatusCode.OK,
            Body = key
        };

    }
}
