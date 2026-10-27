using System.Reflection;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using NUnit.Framework;
using ProjectTestsLib.Helper;
using ServerlessAPI.Functions;

namespace ServerlessAPI.Tests;

[TestFixture]
public class ResetMarksTests
{
    private const string Student = "student@example.com";
    private const string OtherStudent = "other@example.com";
    private string? passedTable;
    private string? failedTable;

    [SetUp]
    public void SetUp()
    {
        passedTable = Environment.GetEnvironmentVariable("PASSED_TEST_TABLE");
        failedTable = Environment.GetEnvironmentVariable("FAILED_TEST_TABLE");
        Environment.SetEnvironmentVariable("PASSED_TEST_TABLE", "passed");
        Environment.SetEnvironmentVariable("FAILED_TEST_TABLE", "failed");
    }

    [TearDown]
    public void TearDown()
    {
        Environment.SetEnvironmentVariable("PASSED_TEST_TABLE", passedTable);
        Environment.SetEnvironmentVariable("FAILED_TEST_TABLE", failedTable);
    }

    [TestCase("GET", 405)]
    [TestCase("DELETE", 405)]
    [TestCase("OPTIONS", 200)]
    public async Task OnlyPostCanResetMarks(string method, int status)
    {
        var handler = new ResetMarksFunction(_ => throw new Exception("Unexpected lookup"),
            _ => throw new Exception("Unexpected reset"));
        var result = await handler.ResetMarksHandler(new APIGatewayProxyRequest { HttpMethod = method }, Context());
        Assert.That(result.StatusCode, Is.EqualTo(status));
    }

    [TestCase(null)]
    [TestCase("")]
    [TestCase("   ")]
    public async Task MissingKeyNeverLooksUpOrDeletesRecords(string? key)
    {
        var request = Request();
        request.Headers = key == null ? null : new Dictionary<string, string> { ["x-api-key"] = key };
        var handler = new ResetMarksFunction(_ => throw new Exception("Unexpected lookup"),
            _ => throw new Exception("Unexpected reset"));
        Assert.That((await handler.ResetMarksHandler(request, Context())).StatusCode, Is.EqualTo(401));
    }

    [TestCase(null)]
    [TestCase("")]
    [TestCase("not-an-email")]
    public async Task UnknownOrInvalidIdentityCannotResetMarks(string? email)
    {
        var handler = new ResetMarksFunction(_ => Task.FromResult(email),
            _ => throw new Exception("Unexpected reset"));
        Assert.That((await handler.ResetMarksHandler(Request(), Context())).StatusCode, Is.EqualTo(401));
    }

    [Test]
    public async Task ResetUsesOnlyTheApiKeyOwnerIgnoringCallerSuppliedIdentity()
    {
        string? deletedUser = null;
        var handler = new ResetMarksFunction(key =>
        {
            Assert.That(key, Is.EqualTo("own-key"));
            return Task.FromResult<string?>(Student);
        }, email => { deletedUser = email; return Task.CompletedTask; });
        var request = Request();
        request.Headers = new Dictionary<string, string> { ["X-API-Key"] = "own-key" };
        request.QueryStringParameters = new Dictionary<string, string> { ["email"] = OtherStudent, ["user"] = OtherStudent };
        request.Body = $$"""{"email":"{{OtherStudent}}","User":"{{OtherStudent}}"}""";
        var result = await handler.ResetMarksHandler(request, Context());
        Assert.That(result.StatusCode, Is.EqualTo(200));
        Assert.That(result.Body, Does.Contain("\"isSuccess\":true"));
        Assert.That(deletedUser, Is.EqualTo(Student));
    }

    [TestCase(true)]
    [TestCase(false)]
    public async Task LookupOrDeletionFailureNeverReportsSuccess(bool lookupFails)
    {
        var handler = new ResetMarksFunction(
            _ => lookupFails ? throw new Exception("Sensitive detail") : Task.FromResult<string?>(Student),
            _ => throw new Exception("Sensitive detail"));
        var result = await handler.ResetMarksHandler(Request(), Context());
        Assert.That(result.StatusCode, Is.EqualTo(500));
        Assert.That(result.Body, Does.Not.Contain("Sensitive detail"));
        Assert.That(result.Body, Does.Contain("try again"));
    }

    [Test]
    public async Task ResetPaginatesBothPartitionsAndPreservesOtherStudents()
    {
        var (client, state) = Database();
        await new DynamoDB(client, new Logger()).ResetMarks(Student);
        Assert.That(state.Records, Has.Count.EqualTo(2));
        Assert.That(state.Records.All(record => record.User == OtherStudent), Is.True);
        Assert.That(state.Deletes, Has.Count.EqualTo(6));
        Assert.That(state.Deletes.All(request => request.Key["User"].S == Student), Is.True);
        Assert.That(state.Queries.Count(request => request.TableName == "passed"), Is.EqualTo(2));
        Assert.That(state.Queries.Count(request => request.TableName == "failed"), Is.EqualTo(2));
        Assert.That(state.Queries.Count(request => request.ExclusiveStartKey?.Count > 0), Is.EqualTo(2));
        foreach (var request in state.Queries)
        {
            Assert.That(request.KeyConditionExpression, Is.EqualTo("#user = :user"));
            Assert.That(request.ExpressionAttributeValues[":user"].S, Is.EqualTo(Student));
            Assert.That(request.ExpressionAttributeNames["#user"], Is.EqualTo("User"));
            Assert.That(request.ConsistentRead, Is.True);
        }
    }

    [Test]
    public async Task ResetIsSafeToRetryAfterPartialDeletion()
    {
        var (client, state) = Database();
        state.FailDeleteNumber = 2;
        var database = new DynamoDB(client, new Logger());
        await Assert.ThrowsAsync<InvalidOperationException>(async () => await database.ResetMarks(Student));
        Assert.That(state.Records.Count(record => record.User == Student), Is.LessThan(6));
        state.FailDeleteNumber = null;
        await database.ResetMarks(Student);
        await database.ResetMarks(Student);
        Assert.That(state.Records, Has.Count.EqualTo(2));
        Assert.That(state.Records.All(record => record.User == OtherStudent), Is.True);
    }

    [Test]
    public async Task ResetRejectsAnEmptyOwnerBeforeCallingTheDatabase()
    {
        var (client, state) = Database();
        await Assert.ThrowsAsync<ArgumentException>(async () => await new DynamoDB(client, new Logger()).ResetMarks(""));
        Assert.That(state.Queries, Is.Empty);
        Assert.That(state.Deletes, Is.Empty);
    }

    private static APIGatewayProxyRequest Request() => new()
    {
        HttpMethod = "POST",
        Headers = new Dictionary<string, string> { ["x-api-key"] = "own-key" }
    };

    private static ILambdaContext Context() => DispatchProxy.Create<ILambdaContext, ContextProxy>();

    private static (IAmazonDynamoDB Client, DatabaseClient State) Database()
    {
        var client = new DatabaseClient();
        var state = client;
        foreach (var table in new[] { "passed", "failed" })
        {
            state.Records.AddRange(Enumerable.Range(1, 3).Select(index => (table, Student, index.ToString())));
            state.Records.Add((table, OtherStudent, "1"));
        }
        return (client, state);
    }

    public class ContextProxy : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? method, object?[]? args) =>
            method?.Name == "get_Logger" ? new Logger() : throw new NotSupportedException(method?.Name);
    }

    public class Logger : ILambdaLogger
    {
        public void Log(string message) { }
        public void LogLine(string message) { }
    }

    public class DatabaseClient : AmazonDynamoDBClient
    {
        public DatabaseClient() : base(new Amazon.Runtime.AnonymousAWSCredentials(),
            new AmazonDynamoDBConfig { RegionEndpoint = Amazon.RegionEndpoint.USEast1 }) { }

        public List<(string Table, string User, string Sort)> Records { get; } = [];
        public List<QueryRequest> Queries { get; } = [];
        public List<DeleteItemRequest> Deletes { get; } = [];
        public int? FailDeleteNumber { get; set; }

        public override Task<QueryResponse> QueryAsync(QueryRequest query, CancellationToken cancellationToken = default)
        {
            Queries.Add(query);
            var sortKey = query.TableName == "passed" ? "Test" : "TestTime";
            var cursor = query.ExclusiveStartKey?.GetValueOrDefault(sortKey)?.S ?? "";
            var records = Records.Where(record => record.Table == query.TableName &&
                record.User == query.ExpressionAttributeValues[":user"].S &&
                string.CompareOrdinal(record.Sort, cursor) > 0).OrderBy(record => record.Sort).ToList();
            var page = records.Take(2).ToList();
            return Task.FromResult(new QueryResponse
            {
                Items = page.Select(record => new Dictionary<string, AttributeValue>
                {
                    [sortKey] = new() { S = record.Sort }
                }).ToList(),
                LastEvaluatedKey = records.Count > page.Count ? new()
                {
                    ["User"] = new() { S = page[^1].User },
                    [sortKey] = new() { S = page[^1].Sort }
                } : []
            });
        }

        public override Task<DeleteItemResponse> DeleteItemAsync(DeleteItemRequest delete,
            CancellationToken cancellationToken = default)
        {
            Deletes.Add(delete);
            if (Deletes.Count == FailDeleteNumber) throw new InvalidOperationException("Temporary failure");
            var sortKey = delete.TableName == "passed" ? "Test" : "TestTime";
            Records.RemoveAll(record => record.Table == delete.TableName &&
                record.User == delete.Key["User"].S && record.Sort == delete.Key[sortKey].S);
            return Task.FromResult(new DeleteItemResponse());
        }
    }
}
