using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Xml.Linq;
using NUnit.Framework;
using ProjectTestsLib.Helper;
using ServerlessAPI.Functions;
using ServerlessAPI.Helper;

namespace ServerlessAPI.Tests;

[TestFixture]
public class GradingTests
{
    [TestCase(false)]
    [TestCase(false, 0)]
    [TestCase(false, 10, 0)]
    [TestCase(true, 10, 20)]
    public void SuccessRequiresNonemptyPositiveResults(bool expected, params int[] marks)
    {
        var result = new NunitTestResult
        {
            LogUrl = "",
            JsonResultUrl = "",
            XmlResultUrl = "",
            TestResults = marks.Select((mark, index) => (mark, index))
                .ToDictionary(item => item.index.ToString(), item => item.mark)
        };
        Assert.That(result.IsSuccess, Is.EqualTo(expected));
    }

    [Test]
    public void ParsesNestedCasesAndAwardsEachMethodsReward()
    {
        var tasks = GameFunction.GetTasksJson();
        var methods = typeof(GameTaskAttribute).Assembly.GetTypes()
            .SelectMany(type => type.GetMethods())
            .Where(method => method.GetCustomAttribute<GameTaskAttribute>() != null)
            .ToArray();
        Assert.That(methods, Is.Not.Empty);

        foreach (var method in methods)
        {
            var fullname = method.DeclaringType!.FullName + "." + method.Name;
            var expectedReward = method.GetCustomAttribute<GameTaskAttribute>()!.Reward;
            Assert.That(tasks.Any(task => task.Tests.Contains(fullname)), Is.True);
            foreach (var depth in new[] { 1, 3, 5 })
            {
                var root = new XElement("test-run");
                var parent = root;
                for (var index = 0; index < depth; index++)
                {
                    var suite = new XElement("test-suite");
                    parent.Add(suite);
                    parent = suite;
                }
                parent.Add(new XElement("test-case",
                    new XAttribute("fullname", fullname), new XAttribute("result", "Passed")));
                parent.Add(new XElement("test-case",
                    new XAttribute("fullname", "Unknown.Failed"), new XAttribute("result", "Failed")));

                var results = Parse(root.ToString());
                Assert.That(results[fullname], Is.EqualTo(expectedReward), fullname);
                Assert.That(results["Unknown.Failed"], Is.Zero);
            }
        }
    }

    [Test]
    public void EmptyReportHasNoPassingResults()
    {
        Assert.That(Parse("<test-run><test-suite /></test-run>"), Is.Empty);
    }

    [Test]
    public void FailedKnownTestReceivesNoReward()
    {
        var fullname = GameFunction.GetTasksJson().First().Tests.First();
        var xml = new XElement("test-run", new XElement("test-suite",
            new XElement("test-case", new XAttribute("fullname", fullname),
                new XAttribute("result", "Failed"))));
        Assert.That(Parse(xml.ToString())[fullname], Is.Zero);
    }

    [Test]
    public void ResponsesPreserveCamelCaseAndCorsHeaders()
    {
        var response = ApiResponse.CreateResponse(HttpStatusCode.OK, new { TestResults = new { Mark = 10 } });
        using var json = JsonDocument.Parse(response.Body);
        Assert.That(response.StatusCode, Is.EqualTo(200));
        Assert.That(json.RootElement.GetProperty("testResults").GetProperty("mark").GetInt32(), Is.EqualTo(10));
        Assert.That(response.Headers["Content-Type"], Is.EqualTo("application/json"));
        Assert.That(response.Headers["Access-Control-Allow-Origin"], Is.EqualTo("*"));
    }

    private static Dictionary<string, int> Parse(string xml)
    {
        var runner = new TestRunner(null!, null!);
        var parser = typeof(TestRunner).GetMethod("ParseNUnitTestResult",
            BindingFlags.NonPublic | BindingFlags.Instance, [typeof(string)])!;
        return (Dictionary<string, int>)parser.Invoke(runner, [xml])!;
    }
}
