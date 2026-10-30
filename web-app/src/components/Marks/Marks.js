import React, { Component } from "react";
import Table from "react-bootstrap/Table";
import Button from "react-bootstrap/Button";
import Aws from "../../lib/Aws";

class Marks extends Component {
  constructor(props) {
    super(props);
    this.loadingMarks = false;
    this.state = {
      testResults: [],
      theLastFailedTest: null,
      error: "",
      loading: true,
      resetting: false,
      resetMessage: "",
    };
  }
  componentDidMount() {
    this.loadMarks();
  }

  loadMarks = () => {
    if (this.loadingMarks || this.state.resetting) return;
    this.loadingMarks = true;
    this.setState({ loading: true, error: "", resetMessage: "" });
    const aws = new Aws();
    const urlWithQueryParams = aws.getApiUrl("getpassedtest");
    if (!urlWithQueryParams) {
      this.loadingMarks = false;
      this.setState({ loading: false });
      return;
    }

    const passed = fetch(urlWithQueryParams, {
      headers: {
        "x-api-key": localStorage.getItem("api_key")
      }
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Unable to load marks.");
        }
        return response.json();
      })
      .then((data) => {
        if (!Array.isArray(data)) {
          throw new Error("Unable to load marks.");
        }
        this.setState({ testResults: data }); // Save the data in the component's state
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
        this.setState({ error: "Unable to load marks. Please try again." });
      });

    const urlWithQueryParams2 = aws.getApiUrl("getthelastfailedtest");

    const failed = fetch(urlWithQueryParams2, {
      headers: {
        "x-api-key": localStorage.getItem("api_key")
      }
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Unable to load the last failed test.");
        }
        return response.json();
      })
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({
          theLastFailedTest: data && !Array.isArray(data) ? data : null,
        });
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
        this.setState({ error: "Unable to load the last failed test. Please try again." });
      });
    Promise.all([passed, failed]).then(() => {
      this.loadingMarks = false;
      this.setState({ loading: false });
    });
  };

  resetMarks = async () => {
    if (this.state.loading || this.state.resetting) return;
    const url = new Aws().getApiUrl("resetmarks");
    if (!url) return;
    const key = localStorage.getItem("api_key");
    if (!window.confirm(
      "Permanently reset all of your marks and failed-test history? " +
      "Your API key and AWS account link will be kept. " +
      "Close game tabs and wait for any grading to finish before continuing."
    )) return;
    this.setState({ resetting: true, error: "", resetMessage: "" });
    try {
      const response = await fetch(url, { method: "POST", headers: { "x-api-key": key } });
      if (!response.ok || (await response.json())?.isSuccess !== true) throw new Error("Reset failed.");
      if (localStorage.getItem("api_key") !== key) throw new Error("Key changed.");
      let owner;
      try {
        const digest = await window.crypto?.subtle?.digest("SHA-256", new TextEncoder().encode(key));
        if (digest) owner = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      } catch {
        // Keep reset compatible with browsers without Web Crypto.
      }
      if (localStorage.getItem("api_key") !== key) throw new Error("Key changed.");
      localStorage.removeItem("filter");
      sessionStorage.removeItem("aws-warrior:v2:quest");
      const stamp = Date.now().toString();
      localStorage.setItem("aws-warrior:marks-reset", owner ? JSON.stringify({ owner, stamp }) : stamp);
      this.setState({
        testResults: [],
        theLastFailedTest: null,
        resetMessage: "Your marks and failed-test history have been reset.",
      });
    } catch {
      this.setState({ error: "Unable to finish resetting marks. Some records may already be removed. Check your API key and retry." });
    } finally {
      this.setState({ resetting: false });
    }
  };

  handleButtonClick = (event) => {
    event.preventDefault();
    window.open("game.html", "_blank");
  };

  render() {
    const { testResults, theLastFailedTest } = this.state;
    return (
      <div>
        <h2>Your Marks</h2>
        {this.state.error && <p role="alert">{this.state.error}</p>}
        {this.state.resetMessage && <p role="status">{this.state.resetMessage}</p>}
        <Button variant="outline-primary" onClick={this.handleButtonClick}>
          Play Classic
        </Button>
        <a className="btn btn-primary ms-2" href="game-v2.html" target="_blank" rel="noopener noreferrer">
          Play AWS Warrior V2
        </a>
        <Button variant="outline-secondary" className="ms-2" onClick={this.loadMarks}
          disabled={this.state.loading || this.state.resetting}>
          {this.state.loading ? "Loading marks..." : "Refresh marks"}
        </Button>
        <Button variant="outline-danger" className="ms-2" onClick={this.resetMarks}
          disabled={this.state.loading || this.state.resetting}>
          {this.state.resetting ? "Resetting marks..." : "Reset my marks"}
        </Button>
        {theLastFailedTest && (
          <>
            <h3>The Last Failed Test</h3>
            <p>
              Name: {theLastFailedTest.test} ({theLastFailedTest.time})
            </p>
            <p>
              <a href={theLastFailedTest.logUrl} target="_blank" rel="noreferrer">
                Test Log
              </a>
            </p>
          </>
        )}
        <h3>The Passed Test</h3>
        <Table striped bordered hover>
          <thead>
            <tr>
              <th>Test</th>
              <th>Mark</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {testResults.map((result, index) => (
              <tr key={index}>
                <td>{result.test}</td>
                <td>{result.mark}</td>
                <td>{result.time}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    );
  }
}

export default Marks;
