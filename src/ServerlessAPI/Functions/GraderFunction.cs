
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using Amazon;
using Amazon.DynamoDBv2;
using Microsoft.AspNetCore.StaticFiles;
using System.Net;


namespace ServerlessAPI.Functions;
public class GraderFunction
{
    private ILambdaLogger? logger;
    private DynamoDB? dynamoDB;
    private TestRunner? testRunner;

    public async Task<APIGatewayHttpApiV2ProxyResponse> FunctionHandler(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
    {

        logger = context.Logger;
        string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
        dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), logger);
        testRunner = new TestRunner(logger, new AmazonS3(new FileExtensionContentTypeProvider()));

        if (!request.Headers.ContainsKey("x-api-key"))
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.OK, "Options request");
        }

        var apiKey = request.Headers["x-api-key"];

        var queryStringParameters = request.QueryStringParameters;
        if (queryStringParameters == null)
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.BadRequest, "Invalid request");
        }

        var filter = queryStringParameters.ContainsKey("filter") ? queryStringParameters["filter"] : "";
        var region = queryStringParameters.ContainsKey("region") ? queryStringParameters["region"] : "us-east-1";
        var graderParameter = queryStringParameters.ContainsKey("grader_parameter") ? queryStringParameters["grader_parameter"] : "";

        var user = await dynamoDB.GetUserApiKey(apiKey);
        if (user == null)
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.Forbidden, "Invalid User and key");
        }

        logger.LogInformation("GraderController.Get called for email: " + user.Email + " with filter: " + filter);

        var awsTestConfig = new AwsTestConfig(user.AccessKeyId, user.SecretAccessKey, user.SessionToken, user.Email, region, graderParameter, filter);
        var results = await testRunner.RunUnitTest(awsTestConfig);
        await dynamoDB.SaveTestResults(user.Email, results);
        return ApiResponse.CreateResponse(HttpStatusCode.OK, results);
    }

    public class Student
    {
        public required string Email { get; set; }
    }

    public async Task<string> StepFunctionHandler(Student student, ILambdaContext context)
    {
        logger = context.Logger;
        try
        {
            string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
            dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), logger);
            testRunner = new TestRunner(logger, new AmazonS3(new FileExtensionContentTypeProvider()));

            var filter = "";
            var region = "us-east-1";
            var graderParameter = "";

            logger.LogInformation("StepFunctionHandler called for email: " + student.Email);
            var user = await dynamoDB.GetUserByEmail(student.Email);

            if (user == null)
            {
                return student.Email + " not found.";
            }
            logger.LogInformation("StepFunctionHandler called for User.email: " + user.Email + " with filter: " + filter);

            var awsTestConfig = new AwsTestConfig(user.AccessKeyId, user.SecretAccessKey, user.SessionToken, user.Email, region, graderParameter, filter);
            var results = await testRunner.RunUnitTest(awsTestConfig);
            await dynamoDB.SaveTestResults(user.Email, results);
            return student.Email + " ok";
        }
        catch (Exception e)
        {
            logger.LogError(e.Message);
            return student.Email + " failed with error: " + e.Message;
        }

    }
}