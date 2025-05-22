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
            logger = context.Logger;
            string region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(region)), logger);
           
            awsAccount = new AwsAccount();
         
            if(!request.Headers.ContainsKey("x-api-key"))
            {
                return ApiResponse.CreateResponseMessage(System.Net.HttpStatusCode.OK, "Options request");
            }            

            if (!TryGetQueryParameters(request.QueryStringParameters, out var accessKeyId, out var secretAccessKey, out var sessionToken))
            {
                return ApiResponse.CreateResponseMessage(System.Net.HttpStatusCode.OK, "Invalid request");
            }

            string awsAccountNumber;
            try
            {
                awsAccountNumber = await awsAccount.GetAwsAccountNumber(accessKeyId, secretAccessKey, sessionToken);
            }
            catch (Amazon.SecurityToken.AmazonSecurityTokenServiceException)
            {
                return ApiResponse.CreateResponseMessage(System.Net.HttpStatusCode.OK, "The AWS credentials are expired");
            }

            var apiKey = request.Headers["x-api-key"];
            var status = await dynamoDB.RegisterUser(apiKey, awsAccountNumber, accessKeyId, secretAccessKey, sessionToken);
            var result = $"Your AWS account is {awsAccountNumber} and {SplitPascalCase(status.ToString()).ToLower()}.";

            return ApiResponse.CreateResponseMessage(System.Net.HttpStatusCode.OK, result);
        }

        private bool TryGetQueryParameters(IDictionary<string, string>? queryParams, out string accessKeyId, out string secretAccessKey, out string sessionToken)
        {
            accessKeyId = secretAccessKey = sessionToken = string.Empty;

            if (queryParams == null ||
                !queryParams.TryGetValue("aws_access_key", out var accessKey) ||
                !queryParams.TryGetValue("aws_secret_access_key", out var secretKey) ||
                !queryParams.TryGetValue("aws_session_token", out var session) ||
                string.IsNullOrEmpty(accessKey) ||
                string.IsNullOrEmpty(secretKey) ||
                string.IsNullOrEmpty(session))
            {
                return false;
            }
            
            accessKeyId = accessKey;
            secretAccessKey = secretKey;
            sessionToken = session;

            return true;
        }

        private string SplitPascalCase(string input)
        {
            return Regex.Replace(input, "(\\B[A-Z])", " $1");
        }
    }
}