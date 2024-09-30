using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Controllers;

[Route("api/[controller]")]
[Produces("application/json")]
public class GraderController : ControllerBase
{
    private readonly ILogger<GraderController> logger;
    private readonly TestRunner testRunner;
    private readonly DynamoDB dynamoDB;
  

    public GraderController(ILogger<GraderController> logger, TestRunner testRunner, DynamoDB dynamoDB)
    {
        this.logger = logger;
        this.testRunner = testRunner;
        this.dynamoDB = dynamoDB;       
    }

    // GET api/grader
    [HttpGet]
    [Produces("application/json")]
    public async Task<IActionResult> Get(
        [FromQuery(Name = "api_key")] string apiKey,
        [FromQuery] string filter = "",
        [FromQuery] string region = "us-east-1",
        [FromQuery(Name = "grader_parameter")] string graderParameter = "")
    {
        logger.LogInformation("GraderController.Get called");
        if (string.IsNullOrEmpty(apiKey))
        {
            return BadRequest("Invalid request");
        }

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

}
