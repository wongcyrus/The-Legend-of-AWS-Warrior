using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Controllers;

[Route("api/[controller]")]
[Produces("application/json")]
public class MarksController : ControllerBase
{
    private readonly ILogger<MarksController> logger;
    private readonly DynamoDB dynamoDB;
    public MarksController(ILogger<MarksController> logger, DynamoDB dynamoDB)
    {
        this.logger = logger;
        this.dynamoDB = dynamoDB;
    }

    // GET: api/Marks
    [HttpGet]
    public async Task<JsonResult> Get([FromQuery(Name = "api_key")] string apiKey)
    {
        logger.LogInformation("MarksController.Get called");
        var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);
        // Check if the email is valid
        var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
        if (!isValidEmail)
        {
            return new JsonResult(Array.Empty<TestRecord>());
        }
        var passedTest = await dynamoDB.GetPassedTests(email);
        return new JsonResult(passedTest);
    }
}
