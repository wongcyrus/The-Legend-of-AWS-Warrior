using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Controllers;

[Route("api/[controller]")]
[Produces("application/json")]
public class AwsAccountController : ControllerBase
{
    private readonly ILogger<GraderController> logger;
    private readonly DynamoDB dynamoDB;
    private readonly AwsAccount awsAccount;

    public AwsAccountController(ILogger<GraderController> logger, DynamoDB dynamoDB, AwsAccount awsAccount)
    {
        this.logger = logger;
        this.dynamoDB = dynamoDB;
        this.awsAccount = awsAccount;
    }

    [HttpGet]
    public async Task<JsonResult> Get(
        [FromQuery(Name = "aws_access_key")] string accessKeyId,
        [FromQuery(Name = "aws_secret_access_key")] string secretAccessKey,
        [FromQuery(Name = "aws_session_token")] string sessionToken,
        [FromQuery(Name = "api_key")] string apiKey)
    {
        logger.LogInformation("AwsAccountController.Get called.");
        if (string.IsNullOrEmpty(accessKeyId) || string.IsNullOrEmpty(secretAccessKey) || string.IsNullOrEmpty(sessionToken) || string.IsNullOrEmpty(apiKey))
        {
            return new JsonResult("Invalid request");
        }

        string awsAccountNumber;
        try
        {           
            awsAccountNumber = await awsAccount.GetAwsAccountNumber(accessKeyId, secretAccessKey, sessionToken);
        } catch (Amazon.SecurityToken.AmazonSecurityTokenServiceException ){
            return new JsonResult("The AWS credentials is expired");
        }
        
        var status = await dynamoDB.RegisterUser(apiKey, awsAccountNumber, accessKeyId, secretAccessKey, sessionToken);

        var result = "Your aws account is " + awsAccountNumber + " and " + SplitPascalCase(status.ToString()).ToLower() + ".";
        return new JsonResult(result);
    }

    private string SplitPascalCase(string input)
    {
        return Regex.Replace(input, "(\\B[A-Z])", " $1");
    }
}