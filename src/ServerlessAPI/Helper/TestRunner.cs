
using System.Reflection;
using System.Xml;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using NUnit.Common;
using NUnitLite;
using ProjectTestsLib;
using ProjectTestsLib.Helper;
using ServerlessAPI.Controllers;

namespace ServerlessAPI.Helper;

public class NunitTestResult
{
    public required string LogUrl { get; set; }
    public required string JsonResultUrl { get; set; }
    public required string XmlResultUrl { get; set; }
    public required Dictionary<string, int> TestResults { get; set; }

    public bool IsSuccess => TestResults.Values.All(c => c > 0);
}
public class TestRunner
{
    private readonly ILogger<TestRunner> logger;
    private readonly AmazonS3 amazonS3;

    public TestRunner(ILogger<TestRunner> logger, AmazonS3 amazonS3)
    {
        this.logger = logger;
        this.amazonS3 = amazonS3;
    }

    private static string GetTemporaryDirectory(string trace)
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName(), Math.Abs(trace.GetHashCode()).ToString());
        Directory.CreateDirectory(tempDirectory);
        return tempDirectory;
    }

    public async Task<NunitTestResult> RunUnitTest(AwsTestConfig awsTestConfig)
    {
        (string tempDir, string tempCredentialsFilePath) = await PrepareTestEnvironment(awsTestConfig);
        logger.LogInformation($@"{tempCredentialsFilePath} {awsTestConfig.Trace}");
        RunTestProcess(awsTestConfig, tempDir, tempCredentialsFilePath, out StringWriter strWriter, out int returnCode);
        // logger.LogInformation(strWriter.ToString());
        return await HandleTestResults(tempDir, tempCredentialsFilePath, awsTestConfig, strWriter, returnCode);
    }

    private async Task<NunitTestResult> HandleTestResults(string tempDir, string tempCredentialsFilePath, AwsTestConfig awsTestConfig, StringWriter strWriter, int returnCode)
    {
        var testLogFile = Path.Combine(tempDir, "TestLog.log");
        await File.WriteAllTextAsync(testLogFile, strWriter.ToString());

        var time = DateTime.Now.ToString("yyyyMMddHHmmss");
        var prefix = awsTestConfig.Trace.Replace("@", "_AT_").Replace(".", "_DOT_").Replace(":", "_COLON_");
        await amazonS3.UploadFileToS3Async(testLogFile, Path.Combine(prefix, "TestLog.log"));
        var logUrl = await amazonS3.UploadFileToS3Async(testLogFile, Path.Combine(prefix, "TestLog_" + time + ".log"));
        await amazonS3.UploadFileToS3Async(tempCredentialsFilePath, Path.Combine(prefix, "awsTestConfig.json"));

        // logger.LogInformation(xml);
        if (returnCode == 0)
        {
            var xmlPath = Path.Combine(tempDir, "TestResult.xml");

            await amazonS3.UploadFileToS3Async(xmlPath, Path.Combine(prefix, "TestResult.xml"));
            var xmlResultUrl = await amazonS3.UploadFileToS3Async(xmlPath, Path.Combine(prefix, "TestResult_" + time + ".xml"));

            var xml = await File.ReadAllTextAsync(xmlPath);

            var testesult = ParseNUnitTestResult(xml);

            XmlDocument doc = new XmlDocument();
            doc.LoadXml(xml);

            var jsonText = JsonConvert.SerializeXmlNode(doc);
            var jsonPath = Path.Combine(tempDir, "TestResult.json");
            await File.WriteAllTextAsync(jsonPath, jsonText);

            await amazonS3.UploadFileToS3Async(jsonPath, Path.Combine(prefix, "TestResult.json"));
            var jsonResultUrl = await amazonS3.UploadFileToS3Async(jsonPath, Path.Combine(prefix, "TestResult_" + time + ".json"));


            logger.LogInformation("NUnit success");
            return new NunitTestResult
            {
                LogUrl = logUrl,
                JsonResultUrl = jsonResultUrl,
                XmlResultUrl = xmlResultUrl,
                TestResults = testesult
            };
        }
        logger.LogInformation("NUnit error");
        return new NunitTestResult
        {
            LogUrl = logUrl,
            JsonResultUrl = "",
            XmlResultUrl = "",
            TestResults = GetGameTask(awsTestConfig)!.Tests.ToDictionary(c => c, c => 0)
        };
    }

    private void RunTestProcess(AwsTestConfig awsTestConfig, string tempDir, string tempCredentialsFilePath, out StringWriter strWriter, out int returnCode)
    {
        var filter = GetFilter(awsTestConfig);
        strWriter = new StringWriter();
        var autoRun = new AutoRun(typeof(Constants).GetTypeInfo().Assembly);
        var runTestParameters = new List<string>
        {
            "/test:"+nameof(ProjectTestsLib),
            "--work=" + tempDir,
            "--output=" + tempDir,
            "--err=" + tempDir,
            "--params:AwsTestConfig=" + tempCredentialsFilePath + ";trace=" + awsTestConfig.Trace
        };
        runTestParameters.Insert(1, "--where=" + filter);
        logger.LogInformation(string.Join(" ", runTestParameters));
        returnCode = autoRun.Execute([.. runTestParameters], new ExtendedTextWrapper(strWriter), Console.In);
        logger.LogInformation("returnCode:" + returnCode);
    }

    private static string GetFilter(AwsTestConfig awsTestConfig)
    {
        GameTaskData? matchingTask = GetGameTask(awsTestConfig);
        var filter = matchingTask?.Filter ?? "test==" + nameof(ProjectTestsLib);
        return filter;
    }

    private static GameTaskData? GetGameTask(AwsTestConfig awsTestConfig)
    {
        var tempFilter = awsTestConfig.Filter;
        var trace = awsTestConfig.Trace;
        var serializerSettings = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver()
        };
        var json = GameController.GetTasksJson();
        var matchingTask = json?.FirstOrDefault(c => c.Filter == tempFilter);
        return matchingTask;
    }

    private static async Task<(string, string)> PrepareTestEnvironment(AwsTestConfig awsTestConfig)
    {
        var tempDir = GetTemporaryDirectory(awsTestConfig.Trace);
        var credentials = JsonConvert.SerializeObject(awsTestConfig);
        var tempCredentialsFilePath = Path.Combine(tempDir, "awsTestConfig.json");
        await File.WriteAllLinesAsync(tempCredentialsFilePath, [credentials]);
        return (tempDir, tempCredentialsFilePath);
    }

    private Dictionary<string, int> ParseNUnitTestResult(string rawXml)
    {
        XmlDocument xmlDoc = new XmlDocument();
        xmlDoc.LoadXml(rawXml);
        return ParseNUnitTestResult(xmlDoc);
    }

    private int GetReward(string fullname)
    {
        var json = GameController.GetTasksJson();
        var matchingTask = json?.FirstOrDefault(c => c.Name == fullname);
        return matchingTask?.Reward ?? 0;
    }

    private Dictionary<string, int> ParseNUnitTestResult(XmlDocument xmlDoc)
    {
        var testCases = xmlDoc.SelectNodes("/test-run/test-suite/test-suite/test-suite/test-case");
        var result = new Dictionary<string, int>();
        foreach (XmlNode node in testCases!)
        {
            result.Add(node.Attributes?["fullname"]!.Value!, node.Attributes?["result"]!.Value == "Passed" ? GetReward(node.Attributes?["fullname"]!.Value!) : 0);
        }
        return result;
    }
}