
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using Amazon;
using Amazon.DynamoDBv2;
using Microsoft.AspNetCore.StaticFiles;

namespace ServerlessAPI.Controllers;


public class GraderFunction
{
    private ILambdaLogger? logger;
    private DynamoDB? dynamoDB;
    private TestRunner? testRunner;

    public async Task<APIGatewayHttpApiV2ProxyResponse> Get(APIGatewayHttpApiV2ProxyRequest request, ILambdaContext context)
    {

        this.logger = context.Logger;
        string db_region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;
        this.dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(db_region)), this.logger);
        this.testRunner = new TestRunner(this.logger, new AmazonS3(new FileExtensionContentTypeProvider()));

        var queryStringParameters = request.QueryStringParameters;
        if (queryStringParameters == null || !queryStringParameters.TryGetValue("api_key", out var apiKey) || string.IsNullOrEmpty(apiKey))
        {
            return BadRequest("Invalid request");
        }

        var filter = queryStringParameters.ContainsKey("filter") ? queryStringParameters["filter"] : "";
        var region = queryStringParameters.ContainsKey("region") ? queryStringParameters["region"] : "us-east-1";
        var graderParameter = queryStringParameters.ContainsKey("grader_parameter") ? queryStringParameters["grader_parameter"] : "";

        var user = await dynamoDB.GetUser(apiKey);
        if (user == null)
        {
            return BadRequest("Invalid api key!");
        }

        logger.LogInformation("GraderController.Get called for email: " + user);

        var awsTestConfig = new AwsTestConfig(user.AccessKeyId, user.SecretAccessKey, user.SessionToken, user.Email, region, graderParameter, filter);
        var results = await testRunner.RunUnitTest(awsTestConfig);
        dynamoDB.SaveTestResults(user.Email, results);
        return Ok(results);
    }
    private APIGatewayHttpApiV2ProxyResponse BadRequest(string message)
    {
        return new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = 400,
            Body = message
        };
    }

    private APIGatewayHttpApiV2ProxyResponse Ok(object results)
    {
        return new APIGatewayHttpApiV2ProxyResponse
        {
            StatusCode = 200,
            Body = Newtonsoft.Json.JsonConvert.SerializeObject(results)
        };
    }
}