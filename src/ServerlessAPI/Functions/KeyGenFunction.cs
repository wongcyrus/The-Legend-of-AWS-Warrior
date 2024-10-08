
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
        try
        {
            var amazonAPIGatewayClient = new AmazonAPIGatewayClient();
            var response = await amazonAPIGatewayClient.CreateApiKeyAsync(new CreateApiKeyRequest
            {
                Enabled = true,
                Name = email,
                Value = key,
                StageKeys = new List<StageKey>
            {
                new() {
                    RestApiId = restApiId,
                    StageName = "Prod"
                }
            }
            });
            logger.LogInformation("Key created for email: " + email);

            var usagePlanKeyResponse = await amazonAPIGatewayClient.CreateUsagePlanKeyAsync(new CreateUsagePlanKeyRequest
            {
                KeyId = response.Id,
                KeyType = "API_KEY",
                UsagePlanId = usagePlanId
            });
            logger.LogInformation(usagePlanKeyResponse.Value);
        }
        catch (ConflictException)
        {
            logger.LogInformation("Key already exists for email: " + email);

        }
        return new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = (int)HttpStatusCode.OK,
            Body = key
        };

    }
}
