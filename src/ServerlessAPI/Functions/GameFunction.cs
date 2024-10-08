using System.Net;
using System.Reflection;
using System.Runtime.Serialization;
using Amazon;
using Amazon.DynamoDBv2;
using Amazon.Lambda.APIGatewayEvents;
using Amazon.Lambda.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using ProjectTestsLib.Helper;
using ServerlessAPI.Helper;


namespace ServerlessAPI.Functions;


public class GameFunction
{
    private ILambdaLogger? logger;
    private DynamoDB? dynamoDB;
    private AwsBedrock? awsBedrock;


    public async Task<APIGatewayHttpApiV2ProxyResponse> FunctionHandler(APIGatewayHttpApiV2ProxyRequest apigProxyEvent,
        ILambdaContext context)
    {
        this.logger = context.Logger;
        string region = Environment.GetEnvironmentVariable("AWS_REGION") ?? RegionEndpoint.USEast2.SystemName;

        this.dynamoDB = new DynamoDB(new AmazonDynamoDBClient(RegionEndpoint.GetBySystemName(region)), this.logger);
        this.awsBedrock = new AwsBedrock(this.logger);

        var apiKey = apigProxyEvent.QueryStringParameters["api_key"];

        if (string.IsNullOrEmpty(apiKey))
        {
            return new APIGatewayHttpApiV2ProxyResponse
            {
                Body = "Invalid apiKey",
                StatusCode = (int)HttpStatusCode.Forbidden,
            };
        }

        var user = await dynamoDB.GetUser(apiKey);
        if (user == null)
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.Forbidden, "Invalid User and key");
        }

        var passedTests = await dynamoDB.GetPassedTestNames(user.Email);
        logger.LogInformation($"Passed tests: {string.Join(", ", passedTests)}");

        var tasks = GetTasksJson();
        var filteredTasks = tasks.Where(t => !t.Tests.All(passedTests.Contains));

        var mode = apigProxyEvent.QueryStringParameters["mode"];
        if (string.IsNullOrEmpty(mode))
        {
            return ApiResponse.CreateResponse(HttpStatusCode.OK, filteredTasks);
        }

        var t = filteredTasks.Take(1).ToArray();
        if (new Random().NextDouble() < 0.7)
        {
            t[0].Instruction = await awsBedrock.RewriteInstruction(t[0].Instruction);
            return ApiResponse.CreateResponse(HttpStatusCode.OK, t);
        }
        else
        {
            return ApiResponse.CreateResponseMessage(HttpStatusCode.OK, await awsBedrock.RandomNPCConversation());
        }
    }

    private static IEnumerable<Type> GetTypesWithHelpAttribute(Assembly assembly)
    {
        return from Type type in assembly!.GetTypes()
               where type.GetCustomAttributes(typeof(GameClassAttribute), true).Length > 0
               select type;
    }


    [DataContract]
    public class GameTaskData
    {
        [DataMember] public int GameClassOrder { get; set; }
        [DataMember] public required string Name { get; set; }
        [DataMember] public required string[] Tests { get; set; }
        [DataMember] public required string Instruction { get; set; }
        [DataMember] public required string Filter { get; set; }
        [DataMember] public int TimeLimit { get; set; }
        [DataMember] public int Reward { get; set; }

        public override string ToString()
        {
            return Name + "," + GameClassOrder + "," + TimeLimit + "," + Reward + "," + Filter + "=>" + Instruction.Substring(0, 30);
        }
    }
    public static IList<GameTaskData> GetTasksJson()
    {
        {
            var assembly = Assembly.GetAssembly(type: typeof(GameClassAttribute));
            var allTasks = new List<GameTaskData>();
            foreach (var testClass in GetTypesWithHelpAttribute(assembly!))
            {
                var gameClass = testClass.GetCustomAttribute<GameClassAttribute>();
                var tasks = testClass.GetMethods().Where(m => m.GetCustomAttribute<GameTaskAttribute>() != null)
                    .Select(c => new { c.Name, GameTask = c.GetCustomAttribute<GameTaskAttribute>()! });

                var independentTests = tasks.Where(c => c.GameTask.GroupNumber == -1)
                    .Select(c => new GameTaskData()
                    {
                        Name = testClass.FullName + "." + c.Name,
                        Tests = [testClass.FullName + "." + c.Name],
                        GameClassOrder = gameClass!.Order,
                        Instruction = c.GameTask.Instruction,
                        Filter = "test=" + testClass.FullName + "." + c.Name,
                        Reward = c.GameTask.Reward,
                        TimeLimit = c.GameTask.TimeLimit
                    });


                var groupedTasks = tasks.Where(c => c.GameTask.GroupNumber != -1)
                    .GroupBy(c => c.GameTask.GroupNumber)
                    .Select(c =>
                        new GameTaskData()
                        {
                            Name = string.Join(" ", c.Select(a => testClass.FullName + "." + a.Name)),
                            Tests = c.Select(a => testClass.FullName + "." + a.Name).ToArray(),
                            GameClassOrder = gameClass!.Order,
                            Instruction = string.Join("", c.Select(a => a.GameTask.Instruction)),
                            Filter =
                                string.Join("||", c.Select(a => "test==\"" + testClass.FullName + "." + a.Name + "\"")),
                            Reward = c.Sum(a => a.GameTask.Reward),
                            TimeLimit = c.Sum(a => a.GameTask.TimeLimit),
                        }
                    );

                allTasks.AddRange(independentTests);
                allTasks.AddRange(groupedTasks);
            }

            var allCompletedTask = allTasks.ToList();
            var serializerSettings = new JsonSerializerSettings
            {
                ContractResolver = new CamelCasePropertyNamesContractResolver()
            };
            allCompletedTask = allCompletedTask.OrderBy(c => c.GameClassOrder).ThenBy(c => c.Tests.First()).ToList();
            // var json = JsonConvert.SerializeObject(allCompletedTask.ToArray(), serializerSettings);                
            return allCompletedTask;
        }
    }
}
