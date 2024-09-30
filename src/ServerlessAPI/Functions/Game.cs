using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;


[assembly: LambdaSerializer(typeof(Amazon.Lambda.Serialization.SystemTextJson.DefaultLambdaJsonSerializer))]

namespace ServerlessAPI.Functions;

public class Function
{

    public Function()
    {

    }

    public async Task<APIGatewayHttpApiV2ProxyResponse> FunctionHandler(APIGatewayHttpApiV2ProxyRequest apigProxyEvent,
        ILambdaContext context)
    {
        if (!apigProxyEvent.RequestContext.Http.Method.Equals(HttpMethod.Get.Method))
        {
            return new APIGatewayHttpApiV2ProxyResponse
            {
                Body = "Only GET allowed",
                StatusCode = (int)HttpStatusCode.MethodNotAllowed,
            };
        }

        try
        {
            var id = apigProxyEvent.QueryStringParameters["id"];

            return new APIGatewayHttpApiV2ProxyResponse
            {
                Body = "id is " + id,
                StatusCode = (int)HttpStatusCode.NotFound,
            };

        }
        catch (Exception e)
        {
            context.Logger.LogLine($"Error getting product {e.Message} {e.StackTrace}");

            return new APIGatewayHttpApiV2ProxyResponse
            {
                Body = "Not Found",
                StatusCode = (int)HttpStatusCode.InternalServerError,
            };
        }
    }
}
