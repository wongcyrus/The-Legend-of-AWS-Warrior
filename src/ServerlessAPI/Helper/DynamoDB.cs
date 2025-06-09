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
        logger.LogInformation("apiKey:" + apiKey);
        var email = AesOperation.DecryptString(Environment.GetEnvironmentVariable("SECRET_HASH")!, apiKey);
        logger.LogInformation("email:" + email);
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

        // Check if user exists       
        var userItem = getUserItemResponse.Item;
        
        bool userExists = userItem != null && userItem.Count > 0;
        
        if (userExists)
        {
            // User exists, check if they have an AWS account number
            if (userItem!.ContainsKey("AwsAccountNumber"))
            {
                var awsAccountAttribute = getUserItemResponse.Item["AwsAccountNumber"];
                var awsAccountNumberInDB = awsAccountAttribute?.S;
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
        }
        
        // Check if AWS account is already registered
        if (getAwsAccountItemResponse.Count != 0)
        {
            return AccountStatus.NotAllowedToShareAwsAccount;
        }
        
        // If user doesn't exist and AWS account is not registered, create a new user
        if (!userExists && getAwsAccountItemResponse.Count == 0)
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
        if (userAccount != null && userAccount.Item != null && userAccount.Item.Count != 0)
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
        if (userAccount != null && userAccount.Item != null && userAccount.Item.Count != 0)
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
            if (getItemResponse.Item == null || getItemResponse.Item.Count == 0)
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
            // Defensive: handle possible nulls in URLs
            var logUrl = nunitTestResult.LogUrl ?? string.Empty;
            var jsonResultUrl = nunitTestResult.JsonResultUrl ?? string.Empty;
            var xmlResultUrl = nunitTestResult.XmlResultUrl ?? string.Empty;
            if (nunitTestResult.LogUrl == null || nunitTestResult.JsonResultUrl == null || nunitTestResult.XmlResultUrl == null)
            {
                logger.LogWarning($"Null URL(s) in NunitTestResult for failed test '{test.Key}'. LogUrl: {nunitTestResult.LogUrl}, JsonResultUrl: {nunitTestResult.JsonResultUrl}, XmlResultUrl: {nunitTestResult.XmlResultUrl}");
            }
            var request = new PutItemRequest
            {
                TableName = failedTesttable,
                Item = new Dictionary<string, AttributeValue>
                    {
                        { "User", new AttributeValue { S = email } },
                        { "TestTime", new AttributeValue { S = now} },
                        { "Test", new AttributeValue { S = test.Key } },
                        { "Time", new AttributeValue { S = now } },
                        { "LogUrl", new AttributeValue { S = logUrl} },
                        { "JsonResultUrl", new AttributeValue { S = jsonResultUrl} },
                        { "XmlResultUrl", new AttributeValue { S = xmlResultUrl} },
                    }
            };
            await dynamoClient.PutItemAsync(request);
        }
    }

    public async Task<string?> GetCachedInstruction(string prompt)
    {
        var cacheTable = Environment.GetEnvironmentVariable("INSTRUCTION_CACHE_TABLE")!;
        var getItemRequest = new GetItemRequest
        {
            TableName = cacheTable,
            Key = new Dictionary<string, AttributeValue>
            {
                { "Id", new AttributeValue { S = prompt } }
            }
        };
        var getItemResponse = await dynamoClient.GetItemAsync(getItemRequest);
        if (getItemResponse.Item != null && getItemResponse.Item.Count != 0)
        {
            return getItemResponse.Item["value"].S;
        }
        return null;
    }

    public async Task SaveCachedInstruction(string prompt, string instruction)
    {
        var cacheTable = Environment.GetEnvironmentVariable("INSTRUCTION_CACHE_TABLE")!;
        var request = new PutItemRequest
        {
            TableName = cacheTable,
            Item = new Dictionary<string, AttributeValue>
            {
                { "Id", new AttributeValue { S = prompt } },
                { "value", new AttributeValue { S = instruction } },
                { "TTL", new AttributeValue { N = (DateTimeOffset.UtcNow.ToUnixTimeSeconds() + TimeSpan.FromMinutes(60).TotalSeconds).ToString() } }
            }
        };
        await dynamoClient.PutItemAsync(request);
    }

}