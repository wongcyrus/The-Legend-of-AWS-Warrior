using System.Threading.Tasks;
using Amazon.Runtime;
using Amazon.SecurityToken;
using Microsoft.Extensions.Logging;

namespace ServerlessAPI.Helper;
public class AwsAccount
{
    private readonly ILogger<AwsAccount> logger;

    public AwsAccount(ILogger<AwsAccount> logger)
    {
        this.logger = logger;        
    }

    public async Task<string> GetAwsAccountNumber(string accessKeyId, string secretAccessKey, string sessionToken)
    {
        var credential = new SessionAWSCredentials(accessKeyId, secretAccessKey, sessionToken);
        AmazonSecurityTokenServiceClient client = new(credential);
        var response = await client.GetCallerIdentityAsync(new Amazon.SecurityToken.Model.GetCallerIdentityRequest());

        return response.Account;
    }
}