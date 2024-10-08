import React, { Component } from "react";
import Form from "react-bootstrap/Form";
import Button from "react-bootstrap/Button";
import Badge from "react-bootstrap/Badge";
import Aws from "../../lib/Aws";

class Home extends Component {
  constructor(props) {
    super(props);
    this.onPasteCaptureApiKey = this.onPasteCaptureApiKey.bind(this);
    this.onPasteCaptureCredentials = this.onPasteCaptureCredentials.bind(this);
    this.onClickReset = this.onClickReset.bind(this);
    this.onClickSave = this.onClickSave.bind(this);
    this.state = {
      api_key: "",
      credentials: "",
      awsAccountStatus: "",
    };
  }

  onPasteCaptureApiKey(e) {
    let api_key = e.clipboardData.getData("text/plain");
    this.setState({ api_key: api_key });
    localStorage.setItem("api_key", api_key);
  }

  onPasteCaptureCredentials(e) {
    let credentials = e.clipboardData.getData("text/plain");
    this.setState({ credentials });
    localStorage.setItem("credentials", credentials);
  }

  onClickReset(e) {
    this.setState({ api_key: "", credentials: "" });
    localStorage.removeItem("credentials");
    localStorage.removeItem("api_key");
  }

  onClickSave(e) {
    const credentials = localStorage.getItem("credentials");
    if (!credentials) {
      alert(
        "Please paste your AWS Academy Learner Lab - AWS credentials first!"
      );
      return;
    }
    const aws = new Aws();
    const extractedCredentials = aws.extractAWSCredentials(credentials);
    const urlWithQueryParams = aws.getApiUrl("awsaccount");
    console.log("Extracted Credentials:", extractedCredentials);
    urlWithQueryParams.searchParams.append(
      "aws_access_key",
      extractedCredentials.aws_access_key_id
    );
    urlWithQueryParams.searchParams.append(
      "aws_secret_access_key",
      extractedCredentials.aws_secret_access_key
    );
    urlWithQueryParams.searchParams.append(
      "aws_session_token",
      extractedCredentials.aws_session_token
    );

    fetch(urlWithQueryParams, {
      headers: {
        "x-api-key": localStorage.getItem("api_key")
      }
    })
      .then((response) => response.json())
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({ awsAccountStatus: data }); // Save the data in the component's state
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
      });
  }

  render() {
    return (
      <div>
        <h2>Set your key</h2>
        <p>
          <lu>
            <li>
              This is a web app that allows you to save your AWS credentials and
              API key in localStorage.
            </li>
            <li>
              The API key is used to authenticate the request to the AWS API
              Gateway.
            </li>
            <li>
              The credentials are used to access your AWS account in the AWS
              Academy Learner Lab and you need to paste a new credentials
              everytime.
            </li>
            <li>
              Click "Save AWS Account" to save your AWS account number with your
              API key and you will not be able to change to another AWS account!
            </li>
          </lu>
        </p>
        <Form>
          <Form.Group className="mb-3" controlId="formBasicApiKey">
            <Form.Label>Copy and paste your Hash Key</Form.Label>
            <Form.Control
              type="text"
              placeholder="API Key"
              value={this.state.api_key}
              onPasteCapture={this.onPasteCaptureApiKey}
              onChange={(e) => { }}
            />
          </Form.Group>
          <Form.Group className="mb-3" controlId="formBasicCredentials">
            <Form.Label>
              Copy and paste your AWS Academy Learner Lab - AWS credentials
            </Form.Label>
            <Form.Control
              as="textarea"
              rows={6}
              className="text-muted"
              value={this.state.credentials}
              onPasteCapture={this.onPasteCaptureCredentials}
              onChange={(e) => { }}
            />
          </Form.Group>
          <Form.Group className="mb-3" controlId="formBasicEmail">
            <Button onClick={this.onClickReset}>Reset</Button>
            <Button onClick={this.onClickSave} variant="danger">
              Save AWS Account credentials
            </Button>
          </Form.Group>
        </Form>
        <Badge bg="secondary">{this.state.awsAccountStatus}</Badge>
      </div>
    );
  }
}

export default Home;
