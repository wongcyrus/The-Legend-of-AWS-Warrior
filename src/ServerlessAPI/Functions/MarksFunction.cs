using System.Net;
using System.Text.RegularExpressions;
using Amazon;
using Amazon.DynamoDBv2;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;

namespace ServerlessAPI.Functions
{
    public class MarksFunction
    {
        private ILambdaLogger? logger;
        private DynamoDB? dynamoDB;

        public async Task<APIGatewayHttpApiV2ProxyResponse> GetPassedTestHandler(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
        {
            logger = context.Logger;
            string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), logger);

            if (!request.Headers.ContainsKey("x-api-key"))
            {
                return ApiResponse.CreateResponseMessage(HttpStatusCode.OK, "Options request");
            }

            var apiKey = request.Headers["x-api-key"];
            
            // Look up email from API Gateway using the API key
            var apiKeyHelper = new ApiKeyHelper(logger);
            var email = await apiKeyHelper.GetEmailFromApiKey(apiKey);
            
            if (string.IsNullOrEmpty(email))
            {
                return ApiResponse.CreateResponseMessage(HttpStatusCode.Unauthorized, "Invalid API key");
            }

            // Check if the email is valid
            var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
            if (!isValidEmail)
            {
                return ApiResponse.CreateResponseMessage(HttpStatusCode.BadRequest, "Invalid email");
            }

            var passedTest = await dynamoDB.GetPassedTests(email);
            return ApiResponse.CreateResponse(HttpStatusCode.OK, passedTest);
        }

        public async Task<APIGatewayHttpApiV2ProxyResponse> GetTheLastFailedTestHandler(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
        {

            logger = context.Logger;
            string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), logger);

            if (!request.Headers.ContainsKey("x-api-key"))
            {
                return ApiResponse.CreateResponseMessage(HttpStatusCode.OK, "Options request");
            }

            var apiKey = request.Headers["x-api-key"];
            
            // Look up email from API Gateway using the API key
            var apiKeyHelper = new ApiKeyHelper(logger);
            var email = await apiKeyHelper.GetEmailFromApiKey(apiKey);
            
            if (string.IsNullOrEmpty(email))
            {
                return ApiResponse.CreateResponse(HttpStatusCode.OK, Array.Empty<string>());
            }

            // Check if the email is valid
            var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
            if (!isValidEmail)
            {
                return ApiResponse.CreateResponse(HttpStatusCode.OK, Array.Empty<string>());
            }

            var theLastFailedTest = await dynamoDB.GetTheLastFailedTest(email);
            return ApiResponse.CreateResponse(HttpStatusCode.OK, theLastFailedTest == null ? Array.Empty<string>() : theLastFailedTest);
        }
    }
}