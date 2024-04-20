using Amazon.EC2;
using Amazon.EC2.Model;
using NUnit.Framework;
using ProjectTestsLib.Helper;
namespace ProjectTestsLib;

[GameClass(2), CancelAfter(Constants.Timeout), Order(2)]
public class T02_VpcTest: AwsTest
{
    private AmazonEC2Client? Ec2Client { get; set; }
    private string? VpcId { get; set; }


    [SetUp]
    public new void Setup()
    {
        base.Setup();
        Ec2Client = new AmazonEC2Client(Credential);
        VpcId = QueryHelper.GetVpcId(Ec2Client);
    }

    [TearDown]
    public void TearDown()
    {
        Ec2Client?.Dispose();
    }

    [GameTask("Create a VPC with CIDR 10.0.0.0/16 and name it as 'Cloud Project VPC'.", 2, 10)]
    [Test, Order(1)]
    public async Task Test01_VpcExist()
    {
        var describeVpcsRequest = new DescribeVpcsRequest();
        describeVpcsRequest.Filters.Add(new Filter("tag:Name", ["Cloud Project VPC"]));
        var describeVpcsResponse = await Ec2Client!.DescribeVpcsAsync(describeVpcsRequest);

        Assert.That(describeVpcsResponse.Vpcs, Has.Count.EqualTo(1));
    }

    [GameTask("In 'Cloud Project VPC', Create 4 subnets with CIDR '10.0.0.0/24','10.0.1.0/24','10.0.4.0/22','10.0.8.0/22'.", 2, 10)]
    [Test, Order(2)]
    public async Task Test02_VpcOf4Subnets()
    {
        DescribeSubnetsRequest describeSubnetsRequest = new();
        describeSubnetsRequest.Filters.Add(new Filter("vpc-id", [VpcId]));
        var describeSubnetsResponse = await Ec2Client!.DescribeSubnetsAsync(describeSubnetsRequest);
        Assert.That(describeSubnetsResponse.Subnets.Count(), Is.EqualTo(4));
        var expectedCidrAddresses = new string[] { "10.0.0.0/24", "10.0.1.0/24", "10.0.4.0/22", "10.0.8.0/22" };
        List<string> acturalCidrAddresses = describeSubnetsResponse.Subnets.Select(c => c.CidrBlock).ToList();
        Assert.That(acturalCidrAddresses, Is.EquivalentTo(expectedCidrAddresses));
    }

}

