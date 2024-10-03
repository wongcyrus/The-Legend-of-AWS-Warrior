using System.Text.RegularExpressions;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;
using Amazon;
using Amazon.DynamoDBv2;

namespace ServerlessAPI.Functions
{
    public class AwsAccountFunction
    {
        private ILambdaLogger? logger;
        private DynamoDB? dynamoDB;
        private AwsAccount? awsAccount;

        public async Task<APIGatewayHttpApiV2ProxyResponse> FunctionHandler(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
        {
            this.logger = context.Logger;
            string region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            this.dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(region)), this.logger);
            awsAccount = new AwsAccount();

            logger.LogInformation("AwsAccountFunction.FunctionHandler called.");

            var queryParams = request.QueryStringParameters;
            if (queryParams == null ||
                !queryParams.TryGetValue("aws_access_key", out var accessKeyId) ||
                !queryParams.TryGetValue("aws_secret_access_key", out var secretAccessKey) ||
                !queryParams.TryGetValue("aws_session_token", out var sessionToken) ||
                !queryParams.TryGetValue("api_key", out var apiKey) ||
                string.IsNullOrEmpty(accessKeyId) ||
                string.IsNullOrEmpty(secretAccessKey) ||
                string.IsNullOrEmpty(sessionToken) ||
                string.IsNullOrEmpty(apiKey))
            {
                return new APIGatewayHttpApiV2ProxyResponse
                {
                    StatusCode = 400,
                    Body = "Invalid request"
                };
            }

            string awsAccountNumber;
            try
            {
                awsAccountNumber = await awsAccount.GetAwsAccountNumber(accessKeyId, secretAccessKey, sessionToken);
            }
            catch (Amazon.SecurityToken.AmazonSecurityTokenServiceException)
            {
                return new APIGatewayHttpApiV2ProxyResponse
                {
                    StatusCode = 400,
                    Body = "The AWS credentials are expired"
                };
            }

            var status = await dynamoDB.RegisterUser(apiKey, awsAccountNumber, accessKeyId, secretAccessKey, sessionToken);
            var result = $"Your AWS account is {awsAccountNumber} and {SplitPascalCase(status.ToString()).ToLower()}.";

            return new APIGatewayHttpApiV2ProxyResponse
            {
                StatusCode = 200,
                Body = result
            };
        }

        private string SplitPascalCase(string input)
        {
            return Regex.Replace(input, "(\\B[A-Z])", " $1");
        }
    }
}