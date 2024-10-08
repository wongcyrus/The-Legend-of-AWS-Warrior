using Amazon.Runtime;
using Amazon.SecurityToken;

namespace ServerlessAPI.Helper;
public class AwsAccount
{
    public async Task<string> GetAwsAccountNumber(string accessKeyId, string secretAccessKey, string sessionToken)
    {
        var credential = new SessionAWSCredentials(accessKeyId, secretAccessKey, sessionToken);
        AmazonSecurityTokenServiceClient client = new(credential);
        var response = await client.GetCallerIdentityAsync(new Amazon.SecurityToken.Model.GetCallerIdentityRequest());

        return response.Account;
    }
}