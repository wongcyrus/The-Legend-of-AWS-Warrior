
using System.Net;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using ServerlessAPI.Helper;

namespace ServerlessAPI.Functions;

public class KeyGenFunction
{
    private ILambdaLogger? logger;

    public APIGatewayHttpApiV2ProxyResponse FunctionHandler(APIGatewayHttpApiV2ProxyRequest apigProxyEvent,
       ILambdaContext context)
    {
        context.Logger.LogLine("GameController.Get called");
        logger = context.Logger;

        var email = apigProxyEvent.QueryStringParameters["email"];
        var hash = apigProxyEvent.QueryStringParameters["hash"];
        logger.LogInformation("KeyGenController.Get called for email: " + email);

        return new APIGatewayHttpApiV2ProxyResponse
        {
            Body = AesOperation.EncryptString(hash, email),
            StatusCode = (int)HttpStatusCode.OK,
        };
    }
}
