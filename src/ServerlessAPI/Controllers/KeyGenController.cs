using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Controllers;

[Route("api/[controller]")]
public class KeyGenController : ControllerBase
{
    private readonly ILogger<GraderController> logger;
    public KeyGenController(ILogger<GraderController> logger)
    {
        this.logger = logger;
    }

    // GET: api/KeyGen
    [HttpGet]
    public string Get([FromQuery] string email, [FromQuery] string hash)
    {
        logger.LogInformation("KeyGenController.Get called for email: " + email);
        return AesOperation.EncryptString(hash, email);
    }
}
