using System.Globalization;
using System.Text.RegularExpressions;
using Amazon.DynamoDBv2;
using Amazon.DynamoDBv2.Model;
using Amazon.Lambda.Core;
using ServerlessAPI.Helper;

namespace ProjectTestsLib.Helper;

public class TestRecord
{
    public required string Test { get; set; }
    public required int Mark { get; set; }
    public required DateTime Time { get; set; }

    public required string LogUrl { get; set; }
    public required string JsonResultUrl { get; set; }
    public required string XmlResultUrl { get; set; }
}

public class User
{
    public required string Email { get; set; }
    public required string AccessKeyId { get; set; }
    public required string SecretAccessKey { get; set; }
    public required string SessionToken { get; set; }
}

public class DynamoDB
{
    private readonly IAmazonDynamoDB dynamoClient;
    private readonly ILambdaLogger logger;

    public DynamoDB(IAmazonDynamoDB dynamoClient, ILambdaLogger logger)
    {
        this.dynamoClient = dynamoClient;
        this.logger = logger;
    }

    public async Task<List<string>> GetPassedTestNames(string email)
    {
        QueryResponse getItemResponse = await GetPassedTestRecords(email);
        if (getItemResponse.Items != null)
        {
            return getItemResponse.Items.Select(c => c["Test"].S).ToList();
        }
        return [];
    }

    public async Task<List<TestRecord>> GetPassedTests(string email)
    {
        QueryResponse getItemResponse = await GetPassedTestRecords(email);
        if (getItemResponse.Items != null)
        {
            return [.. getItemResponse.Items.Select(c => new TestRecord
            {
                Test = c["Test"].S,
                Mark = int.Parse(c["Marks"].N),
                Time = DateTime.ParseExact(c["Time"].S, "yyyyMMddHHmmss", CultureInfo.InvariantCulture),
                LogUrl = c["LogUrl"].S,
                JsonResultUrl = c["JsonResultUrl"].S,
                XmlResultUrl = c["XmlResultUrl"].S
            }).OrderBy(c => c.Test)];
        }
        return [];
    }

    public enum AccountStatus
    {
        NewlyRegistered,
        UpdatedYourKey,
        NotAllowedChangeAwsAccount,
        NotAllowedToShareAwsAccount,
        NotRegistered,
        InvalidApiKey
    }
    public async Task<AccountStatus> RegisterUser(string apiKey, string awsAccountNumber, string accessKeyId, string secretAccessKey, string sessionToken)
    {
        var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);
        // Check if the email is valid
        var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
        if (!isValidEmail)
        {
            return AccountStatus.InvalidApiKey;
        }
        var awsAccountTable = Environment.GetEnvironmentVariable("AWS_ACCOUNT_TABLE")!;
        var getItemRequest = new GetItemRequest
        {
            TableName = awsAccountTable,
            Key = new Dictionary<string, AttributeValue>
            {
                { "User", new AttributeValue { S = email } }
            }
        };
        var getUserItemResponse = await dynamoClient.GetItemAsync(getItemRequest);

        var queryRequest = new QueryRequest
        {
            TableName = awsAccountTable,
            IndexName = "AwsAccountNumberIndex",
            KeyConditionExpression = "AwsAccountNumber = :v_AwsAccountNumber",
            ExpressionAttributeValues = new Dictionary<string, AttributeValue> {
                {":v_AwsAccountNumber", new AttributeValue {
                     S = awsAccountNumber
                 }}
            }
        };
        var getAwsAccountItemResponse = await dynamoClient.QueryAsync(queryRequest);

        if (getUserItemResponse.Item.ContainsKey("AwsAccountNumber"))
        {
            var awsAccountNumberInDB = getUserItemResponse.Item["AwsAccountNumber"].S;
            logger.LogInformation("awsAccountNumberInDB:" + awsAccountNumberInDB);
            if (awsAccountNumberInDB == awsAccountNumber)
            {
                var request = new PutItemRequest
                {
                    TableName = awsAccountTable,
                    Item = new Dictionary<string, AttributeValue>
                {
                    { "User", new AttributeValue { S = email } },
                    { "AwsAccountNumber", new AttributeValue { S = awsAccountNumber } },
                    { "AccessKeyId", new AttributeValue { S = accessKeyId } },
                    { "SecretAccessKey", new AttributeValue { S = secretAccessKey } },
                    { "SessionToken", new AttributeValue { S = sessionToken } },
                    { "Time", new AttributeValue { S =  DateTime.Now.ToString("yyyyMMddHHmmss")} }
                }
                };
                await dynamoClient.PutItemAsync(request);
                return AccountStatus.UpdatedYourKey;
            }
            else
            {
                return AccountStatus.NotAllowedChangeAwsAccount;
            }
        }
        else if (getAwsAccountItemResponse.Count != 0)
        {
            return AccountStatus.NotAllowedToShareAwsAccount;
        }
        if (getUserItemResponse.Item.Count == 0 && getAwsAccountItemResponse.Count == 0)
        {
            // save the user and awsAccountNumber
            var request = new PutItemRequest
            {
                TableName = awsAccountTable,
                Item = new Dictionary<string, AttributeValue>
                {
                    { "User", new AttributeValue { S = email } },
                    { "AwsAccountNumber", new AttributeValue { S = awsAccountNumber } },
                    { "AccessKeyId", new AttributeValue { S = accessKeyId } },
                    { "SecretAccessKey", new AttributeValue { S = secretAccessKey } },
                    { "SessionToken", new AttributeValue { S = sessionToken } },
                    { "Time", new AttributeValue { S =  DateTime.Now.ToString("yyyyMMddHHmmss")} }
                }
            };
            await dynamoClient.PutItemAsync(request);
            return AccountStatus.NewlyRegistered;
        }
        return AccountStatus.NotRegistered;
    }

    public async Task<User?> GetUserApiKey(string apiKey)
    {
        var userAccount = await GetUserAccount(apiKey);
        if (userAccount != null && userAccount.Item.Count != 0)
        {
            return new User
            {
                Email = userAccount.Item["User"].S,
                AccessKeyId = userAccount.Item["AccessKeyId"].S,
                SecretAccessKey = userAccount.Item["SecretAccessKey"].S,
                SessionToken = userAccount.Item["SessionToken"].S
            };
        }
        return null;
    }

    public async Task<User?> GetUserByEmail(string email)
    {
        var userAccount = await GetAccountByEmail(email);
        if (userAccount != null && userAccount.Item.Count != 0)
        {
            return new User
            {
                Email = userAccount.Item["User"].S,
                AccessKeyId = userAccount.Item["AccessKeyId"].S,
                SecretAccessKey = userAccount.Item["SecretAccessKey"].S,
                SessionToken = userAccount.Item["SessionToken"].S
            };
        }
        return null;
    }

    private async Task<GetItemResponse?> GetUserAccount(string apiKey)
    {
        var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);
        // Check if the email is valid
        var isValidEmail = Regex.IsMatch(email, @"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$");
        if (!isValidEmail)
        {
            return null;
        }
        return await GetAccountByEmail(email);
    }

    private async Task<GetItemResponse?> GetAccountByEmail(string email)
    {
        var awsAccountTable = Environment.GetEnvironmentVariable("AWS_ACCOUNT_TABLE")!;
        return await dynamoClient.GetItemAsync(new GetItemRequest
        {
            TableName = awsAccountTable,
            Key = new Dictionary<string, AttributeValue>
            {
                { "User", new AttributeValue { S = email } }
            }
        });
    }

    private async Task<QueryResponse> GetPassedTestRecords(string email)
    {
        var passedTesttable = Environment.GetEnvironmentVariable("PASSED_TEST_TABLE")!;
        var queryRequest = new QueryRequest
        {
            TableName = passedTesttable,
            KeyConditionExpression = "#dynobase_User = :v_user",
            ExpressionAttributeValues = new Dictionary<string, AttributeValue>
            {
                { ":v_user", new AttributeValue { S = email } }
            },
            ExpressionAttributeNames = new Dictionary<string, string>
            {
                { "#dynobase_User", "User" }
            }
        };
        var getItemResponse = await dynamoClient.QueryAsync(queryRequest);
        return getItemResponse;
    }

    public async Task<TestRecord?> GetTheLastFailedTest(string email)
    {
        var passedTesttable = Environment.GetEnvironmentVariable("FAILED_TEST_TABLE")!;
        var queryRequest = new QueryRequest
        {
            TableName = passedTesttable,
            KeyConditionExpression = "#dynobase_User = :v_user",
            ScanIndexForward = false,
            Limit = 1,
            ExpressionAttributeValues = new Dictionary<string, AttributeValue>
            {
                { ":v_user", new AttributeValue { S = email } }
            },
            ExpressionAttributeNames = new Dictionary<string, string>
            {
                { "#dynobase_User", "User" }
            }
        };
        var getItemResponse = await dynamoClient.QueryAsync(queryRequest);
        if (getItemResponse.Items != null && getItemResponse.Items.Count > 0)
        {
            return new TestRecord
            {
                Test = getItemResponse.Items[0]["Test"].S,
                Time = DateTime.ParseExact(getItemResponse.Items[0]["Time"].S, "yyyyMMddHHmmss", CultureInfo.InvariantCulture),
                LogUrl = getItemResponse.Items[0]["LogUrl"].S,
                JsonResultUrl = getItemResponse.Items[0]["JsonResultUrl"].S,
                XmlResultUrl = getItemResponse.Items[0]["XmlResultUrl"].S,
                Mark = 0
            };
        }
        return null;
    }

    public async Task SaveTestResults(string email, NunitTestResult nunitTestResult)
    {
        string now = DateTime.Now.ToString("yyyyMMddHHmmss");
        var tests = nunitTestResult.TestResults;
        var passedTesttable = Environment.GetEnvironmentVariable("PASSED_TEST_TABLE")!;
        var failedTesttable = Environment.GetEnvironmentVariable("FAILED_TEST_TABLE")!;
        var passedTest = tests.Where(x => x.Value > 0).ToList();
        var failedTest = tests.Where(x => x.Value == 0).ToList();

        logger.LogInformation($"Email: {email}, Total tests: {tests.Count}, Passed tests: {passedTest.Count}, Failed tests: {failedTest.Count}");

        foreach (var test in passedTest)
        {
            var getItemRequest = new GetItemRequest
            {
                TableName = passedTesttable,
                Key = new Dictionary<string, AttributeValue>
                {
                    { "User", new AttributeValue { S = email } },
                    { "Test", new AttributeValue { S = test.Key } }
                }
            };

            var getItemResponse = await dynamoClient.GetItemAsync(getItemRequest);

            // logger.LogInformation("Get Item by email:" + email + " test:" + test.Key + " getItemResponse:" + getItemResponse.Item.Count);
            if (getItemResponse.Item.Count == 0)
            {
                var request = new PutItemRequest
                {
                    TableName = passedTesttable,
                    Item = new Dictionary<string, AttributeValue>
                    {
                        { "User", new AttributeValue { S = email } },
                        { "Test", new AttributeValue { S = test.Key } },
                        { "Marks", new AttributeValue { N = test.Value.ToString() } },
                        { "Time", new AttributeValue { S = now } },
                        { "LogUrl", new AttributeValue { S = nunitTestResult.LogUrl} },
                        { "JsonResultUrl", new AttributeValue { S = nunitTestResult.JsonResultUrl} },
                        { "XmlResultUrl", new AttributeValue { S = nunitTestResult.XmlResultUrl} },
                    }
                };
                var result = await dynamoClient.PutItemAsync(request);
                // logger.LogInformation("Put Item by email:" + email + " test:" + test.Key + " result:" + result.HttpStatusCode);                
            }
        }

        foreach (var test in failedTest)
        {
            var request = new PutItemRequest
            {
                TableName = failedTesttable,
                Item = new Dictionary<string, AttributeValue>
                    {
                        { "User", new AttributeValue { S = email } },
                        { "TestTime", new AttributeValue { S = now} },
                        { "Test", new AttributeValue { S = test.Key } },
                        { "Time", new AttributeValue { S = now } },
                        { "LogUrl", new AttributeValue { S = nunitTestResult.LogUrl} },
                        { "JsonResultUrl", new AttributeValue { S = nunitTestResult.JsonResultUrl} },
                        { "XmlResultUrl", new AttributeValue { S = nunitTestResult.XmlResultUrl} },
                    }
            };
            await dynamoClient.PutItemAsync(request);
        }       
    }

}