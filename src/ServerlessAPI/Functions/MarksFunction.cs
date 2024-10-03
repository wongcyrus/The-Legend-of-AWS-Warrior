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
            this.logger = context.Logger;
            string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            this.dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), this.logger);
            var apiKey = request.QueryStringParameters["api_key"];

            var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);

            // Check if the email is valid
            var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
            if (!isValidEmail)
            {
                return new APIGatewayHttpApiV2ProxyResponse
                {
                    StatusCode = 200,
                    Body = "[]"
                };
            }

            var passedTest = await dynamoDB.GetPassedTests(email);
            return new APIGatewayHttpApiV2ProxyResponse
            {
                StatusCode = 200,
                Body = System.Text.Json.JsonSerializer.Serialize(passedTest)
            };
        }

        public async Task<APIGatewayHttpApiV2ProxyResponse> GetTheLastFailedTestHandler(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
        {

            this.logger = context.Logger;
            string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            this.dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), this.logger);

            var apiKey = request.QueryStringParameters["api_key"];
            var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);

            // Check if the email is valid
            var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
            if (!isValidEmail)
            {
                return new APIGatewayHttpApiV2ProxyResponse
                {
                    StatusCode = 200,
                    Body = "[]"
                };
            }

            var theLastFailedTest = await dynamoDB.GetTheLastFailedTest(email);
            return new APIGatewayHttpApiV2ProxyResponse
            {
                StatusCode = 200,
                Body = System.Text.Json.JsonSerializer.Serialize(theLastFailedTest)
            };
        }
    }
}