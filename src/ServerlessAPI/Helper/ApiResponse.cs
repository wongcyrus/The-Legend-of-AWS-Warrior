using Amazon.Lambda.APIGatewayEvents;
using System.Net;
using System.Text.Json;

namespace ServerlessAPI.Helper
{
    public class ApiResponse
    {

        class LowerCaseFirstCharNamingPolicy : JsonNamingPolicy
        {
            public override string ConvertName(string name)
            {
                if (string.IsNullOrEmpty(name) || char.IsLower(name[0]))
                {
                    return name;
                }

                return char.ToLower(name[0]) + name.Substring(1);
            }
        }

        public static APIGatewayHttpApiV2ProxyResponse CreateResponseMessage(HttpStatusCode statusCode, string message) => new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = (int)statusCode,
            Body = JsonSerializer.Serialize(message),
            Headers = new Dictionary<string, string>
                {
                    { "Access-Control-Allow-Origin", "*" },
                    { "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS" },
                    { "Access-Control-Allow-Headers", "Content-Type" }
                }
        };

        public static APIGatewayHttpApiV2ProxyResponse CreateResponse(HttpStatusCode statusCode, object message)
        {
            return new APIGatewayHttpApiV2ProxyResponse
            {
                StatusCode = (int)statusCode,
                Body = JsonSerializer.Serialize(message, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = new LowerCaseFirstCharNamingPolicy()
                }),
                Headers = new Dictionary<string, string>
                {
                    { "Access-Control-Allow-Origin", "*" },
                    { "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS" },
                    { "Access-Control-Allow-Headers", "Content-Type" }
                }
            };
        }
    }
}