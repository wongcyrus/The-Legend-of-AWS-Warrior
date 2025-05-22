using Amazon.Runtime;
using Newtonsoft.Json;
using NUnit.Framework;

namespace ProjectTestsLib.Helper;

public class AwsTestConfig(string accessKeyId, string secretAccessKey, string sessionToken, string trace, string region = "us-east-1", string graderParameter = "", string filter = nameof(ProjectTestsLib))
{
    public string AccessKeyId { get; set; } = accessKeyId;

    public string SecretAccessKey { get; set; } = secretAccessKey;

    public string SessionToken { get; set; } = sessionToken;

    public string Region { get; set; } = region;

    public string GraderParameter { get; set; } = graderParameter;

    public string Trace { get; set; } = trace;

    public string Filter { get; set; } = filter;
    public override string ToString()
    {
        return JsonConvert.SerializeObject(this);
    }
}

public abstract class AwsTest
{
    protected SessionAWSCredentials? Credential { get; set; }
    protected string? Region { get; set; }

    public AwsTestConfig? AwsTestConfig { get; private set; }
    protected void Setup()
    {
        var credentialPath = TestContext.Parameters.Get("AwsTestConfig", null);
        if (credentialPath == null && File.Exists("/workspaces/The-Legend-of-AWS-Warrior/events/awsTestConfig.json"))
        {
            credentialPath = "/workspaces/The-Legend-of-AWS-Warrior/events/awsTestConfig.json";
        }
        credentialPath = credentialPath!.Trim('\'');
        var awsTestConfigString = File.ReadAllText(credentialPath);
        AwsTestConfig = JsonConvert.DeserializeObject<AwsTestConfig>(awsTestConfigString);

        Environment.SetEnvironmentVariable("AWS_REGION", AwsTestConfig!.Region);
        Credential = new SessionAWSCredentials(AwsTestConfig?.AccessKeyId, AwsTestConfig?.SecretAccessKey, AwsTestConfig?.SessionToken);
        Region = AwsTestConfig?.Region!;
    }
}