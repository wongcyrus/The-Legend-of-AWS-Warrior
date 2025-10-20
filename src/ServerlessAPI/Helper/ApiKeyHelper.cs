using Amazon.APIGateway;
using Amazon.APIGateway.Model;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Lambda.Core;

namespace ServerlessAPI.Helper;

public class ApiKeyHelper
{
    private readonly ILambdaLogger logger;
    private readonly AmazonAPIGatewayClient apiGatewayClient;
    private readonly AmazonDynamoDBClient dynamoClient;
    private readonly string lookupTableName;

    public ApiKeyHelper(ILambdaLogger logger)
    {
        this.logger = logger;
        this.apiGatewayClient = new AmazonAPIGatewayClient();
        this.dynamoClient = new AmazonDynamoDBClient();
        this.lookupTableName = Environment.GetEnvironmentVariable("API_KEY_LOOKUP_TABLE") ?? "ApiKeyLookupTable";
    }

    public async Task<string?> GetEmailFromApiKey(string apiKey)
    {
        // Check DynamoDB lookup table first
        try
        {
            var getRequest = new GetItemRequest
            {
                TableName = lookupTableName,
                Key = new Dictionary<string, AttributeValue>
                {
                    { "ApiKey", new AttributeValue { S = apiKey } }
                }
            };

            var response = await dynamoClient.GetItemAsync(getRequest);
            
            if (response.Item != null && response.Item.Count > 0)
            {
                var email = response.Item["Email"].S;
                logger.LogInformation($"Lookup table HIT for API key, returning email: {email}");
                return email;
            }
            
            logger.LogInformation("Lookup table MISS, fetching from API Gateway and storing");
        }
        catch (Exception ex)
        {
            logger.LogWarning($"Error reading from lookup table, will fetch from API Gateway: {ex.Message}");
        }
        
        // Not in lookup table - fetch from API Gateway and store it
        try
        {
            // Get all API keys and find the one matching this value
            var keysResponse = await apiGatewayClient.GetApiKeysAsync(new GetApiKeysRequest
            {
                IncludeValues = true
            });
            
            var matchingKey = keysResponse.Items.FirstOrDefault(k => k.Value == apiKey);
            if (matchingKey == null)
            {
                logger.LogError($"Could not find API key in API Gateway: {apiKey}");
                return null;
            }
            
            var email = matchingKey.Name;  // The email is stored as the key name
            logger.LogInformation($"Found email for API key: {email}");
            
            // Store in DynamoDB lookup table for future requests
            await StoreApiKeyMapping(apiKey, email);
            
            return email;
        }
        catch (Exception ex)
        {
            logger.LogError($"Error looking up API key: {ex.Message}");
            return null;
        }
    }

    private async Task StoreApiKeyMapping(string apiKey, string email)
    {
        try
        {
            var putRequest = new PutItemRequest
            {
                TableName = lookupTableName,
                Item = new Dictionary<string, AttributeValue>
                {
                    { "ApiKey", new AttributeValue { S = apiKey } },
                    { "Email", new AttributeValue { S = email } },
                    { "CreatedAt", new AttributeValue { S = DateTime.UtcNow.ToString("o") } }
                }
            };

            await dynamoClient.PutItemAsync(putRequest);
            logger.LogInformation($"Stored API key -> email mapping in lookup table");
        }
        catch (Exception ex)
        {
            logger.LogWarning($"Failed to store API key mapping (non-critical): {ex.Message}");
        }
    }
}
