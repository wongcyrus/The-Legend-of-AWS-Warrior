import React, { Component } from "react";
import { Dropdown } from "react-bootstrap";
import Aws from "../../lib/Aws";
import Spinner from "react-bootstrap/Spinner";

class Playground extends Component {
  constructor(props) {
    super(props);
    this.state = {
      dropdownData: [], // Initialize an empty array to hold the dropdown data
      selectedItem: null, // Initialize the selected item to null,
      testResult: null,
      loading: false,
    };
  }

  componentDidMount() {
    const aws = new Aws();
    const urlWithQueryParams = aws.getApiUrl("game");
    urlWithQueryParams.searchParams.append("mode", "");

    fetch(urlWithQueryParams)
      .then((response) => response.json())
      .then((data) => {
        // Handle the response data here
        console.log(data);
        this.setState({ dropdownData: data }); // Save the data in the component's state
      })
      .catch((error) => {
        // Handle any errors that occur during the request
        console.error(error);
      });
  }

  handleDropdownChange = (event) => {
    console.log("Event:", event);
    const selectedItem = event; // Get the selected item from the event
    this.setState({ selectedItem }); // Update the selected item in the state
  };

  handleTestButtonClick = () => {
    this.setState({ testResult: null });
    // Handle the test button click here
    console.log("Selected Item:", this.state.selectedItem);
    if (this.state.selectedItem && this.state.dropdownData) {
      const dropdownDataByName = this.state.dropdownData.find(
        (item) => item.name === this.state.selectedItem
      );
      console.log("Dropdown Data by Name:", dropdownDataByName);

      const aws = new Aws();
      const urlWithQueryParams = aws.getApiUrl("grader");
      urlWithQueryParams.searchParams.append(
        "filter",
        dropdownDataByName.filter
      );
      this.setState({ loading: true });
      fetch(urlWithQueryParams)
        .then((response) => response.json())
        .then((result) => {
          this.setState({ testResult: result });
          if (result.isSuccess) {
            let index = this.state.dropdownData.findIndex(
              (item) => item.name === this.state.selectedItem
            );
            console.log("Index:", index);
            if (index !== -1) {
              let newArray = [...this.state.dropdownData];
              newArray.splice(index, 1);
              this.setState({ dropdownData: newArray });
            }
          }
          this.setState({ loading: false });
        })
        .catch((error) => console.error("Error:", error));
    }
  };

  render() {
    const { dropdownData, selectedItem, testResult, loading } = this.state; // Retrieve the dropdown data and selected item from the state
    let selectedItemDetails
    if (Array.isArray(dropdownData)) {
      selectedItemDetails = dropdownData.find(
        (item) => item.name === selectedItem
      );
    } else {
      console.log("dropdownData is not an array");
    }
    
    const validDropdownData = Array.isArray(dropdownData) ? dropdownData : [];
 
    return (
      <div>
        <h2>Tasks</h2>
        <Dropdown onSelect={this.handleDropdownChange}>
          <Dropdown.Toggle variant="success" id="dropdown-basic">
            Select a Task
          </Dropdown.Toggle>
          <Dropdown.Menu>
            {validDropdownData.map((item) => (
              <Dropdown.Item key={item.name} eventKey={item.name}>
                {item.name}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown>
        {selectedItemDetails && (
          <div>
            <h3>Details</h3>
            <p>Name: {selectedItemDetails.name}</p>
            <p>Instruction: {selectedItemDetails.instruction}</p>
            <button onClick={this.handleTestButtonClick}>Test</button>
          </div>
        )}
        {testResult && (
          <div>
            <h3>Test Result</h3>
            {Object.entries(testResult.testResults).map(([key, value]) => (
              <p key={key}>
                {key}: {value} Marks
              </p>
            ))}
            <p>
              <a href={testResult.logUrl} target="blank">
                Log
              </a>
            </p>
            <p>
              <a href={testResult.jsonResultUrl} target="blank">
                JSON Log
              </a>
            </p>
            <p>
              <a href={testResult.xmlResultUrl} target="blank">
                XML Log
              </a>
            </p>
          </div>
        )}
        {loading && (
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading...</span>
          </Spinner>
        )}
      </div>
    );
  }
}
export default Playground;
