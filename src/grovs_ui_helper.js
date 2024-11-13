import GrovsAPIService from "./grovs_api_service";

class GrovsUIHelper {
  constructor() {
    this.service = new GrovsAPIService();
    this.page = 1;
    this.isLoading = false;

    this.htmlContent = `
    <!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Messages</title>
    <link
      href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
      body,
      html {
        margin: 0;
        padding: 0;
        height: 100%;
        width: 100%;
        overflow: hidden; /* Prevent scrolling when modal is open */

        font-family: "Open Sans", sans-serif; /* Use Open Sans font */
        background-color: #f0f0f0; /* Background color for contrast */
        margin: 0; /* Remove default margin */
      }
      .modal {
        display: flex;
        flex-direction: column; /* Column layout for modal content */
        left: 0;
        height: 100%; /* Full viewport height */
        backdrop-filter: blur(10px); /* Blurring effect for the background */
        color: white; /* Text color */
        z-index: 1000;
        padding: 30px; /* Padding for modal */
        padding-bottom: 0px;
        box-sizing: border-box; /* Include padding in width/height calculations */
        border-radius: 30px;
        background-color: rgba(0, 0, 0, 0.5);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2); /* Shadow effect */
      }
      .modal-content {
        flex-grow: 1; /* Allow content to grow */
        border-radius: 10px; /* Rounded corners for the content box */
        position: relative; /* Relative positioning for the close button */
        overflow: hidden; /* Hide overflow */
      }

      #closeModalBtn {
        width: 40px;
        height: 40px;
        border: none; /* Remove border */
        background: transparent; /* Make background transparent */
        cursor: pointer; /* Change cursor on hover */
        display: flex; /* Use flexbox for centering */
        justify-content: center; /* Center the SVG horizontally */
        align-items: center; /* Center the SVG vertically */
        z-index: 1; /* Ensure button is above other content */
        padding: 0; /* Remove any padding */
        margin: 0; /* Remove any margin */
      }
      .header {
        position: sticky; /* Stick the header to the top */
        top: 0; /* Position it at the top */
        z-index: 1; /* Ensure it is above the scrolling content */
        display: flex; /* Use flexbox layout */
        justify-content: space-between; /* Space between the title and the close button */
        align-items: center; /* Center items vertically */
        height: 40px;
        margin-bottom: 20px;
      }
      .item-list {
        max-height: calc(
          100vh - 30vh - 150px
        ); /* Adjust this value to leave space for header and button */
        overflow-y: auto; /* Enable vertical scrolling */
      }
      .item {
        display: flex; /* Flex layout for each item */
        justify-content: space-between; /* Space between title/subtitle and right arrow */
        align-items: center; /* Center vertically */
        padding: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.3); /* Separator line */
        cursor: pointer; /* Pointer cursor on hover */
      }
      .indicator {
        width: 10px; /* Width of the blue indicator */
        height: 10px; /* Height of the blue indicator */
        border-radius: 50%; /* Make it circular */
        background-color: blue; /* Blue color */
        margin-right: 10px; /* Space between indicator and title */
      }
      .right-arrow {
        margin-left: 10px; /* Space between item text and arrow */
        color: white; /* Color of the right arrow */
      }
      .title {
        font-size: 24px;
        font-weight: 600;
        padding-left: 10px;
      }
      .list-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .indicator {
        background-color: #298dfa;
      }
      .item-title {
        font-size: 17px;
        font-weight: 600;
        color: white;
      }
      .item-subtitle {
        color: rgba(255, 255, 255, 0.5);
      }
      .list-title {
        padding-left: 10px;
      }
      .spinner-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 2000; /* Higher than modal */
      }
      .spinner {
        width: 40px;
        height: 40px;
        border: 4px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <div id="spinner" class="spinner-overlay">
      <div class="spinner"></div>
    </div>
    <div class="modal">
      <div class="modal-content">
        <div class="header">
          <h1 class="title">Messages</h1>
          <button id="closeModalBtn">
            <svg
              width="24"
              height="24"
              viewBox="0 0 95 95"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M47.5 0C21.266 0 0 21.266 0 47.5C0 73.734 21.266 95 47.5 95C73.734 95 95 73.734 95 47.5C94.9727 21.277 73.723 0.027 47.5 0ZM66.133 60.535C67.7072 62.0545 67.7502 64.5584 66.2307 66.1327C64.7112 67.7069 62.2073 67.7499 60.633 66.2304C60.6017 66.1991 60.5666 66.1679 60.5353 66.1327L47.5003 53.0977L34.4653 66.1327C32.8911 67.6522 30.3872 67.6093 28.8676 66.035C27.3871 64.4998 27.3871 62.0702 28.8676 60.535L41.9026 47.5L28.8676 34.465C27.3481 32.8908 27.391 30.3869 28.9653 28.8673C30.5005 27.3868 32.9301 27.3868 34.4653 28.8673L47.5003 41.9023L60.5353 28.8673C62.1095 27.3478 64.6134 27.3907 66.133 28.965C67.6135 30.5002 67.6135 32.9298 66.133 34.465L53.098 47.5L66.133 60.535Z"
                fill="white"
              />
            </svg>
          </button>
        </div>
        <div class="item-list" id="itemList">
          <!-- Item list will be populated here -->
        </div>
      </div>
    </div>
  </body>
</html>
  `;
  }

  showMessagesList() {
    // Create modal overlay
    const modalOverlay = document.createElement("div");
    modalOverlay.id = "Grovs-modal";
    modalOverlay.style.position = "fixed";
    modalOverlay.style.top = "15%";
    modalOverlay.style.left = "15%";
    modalOverlay.style.width = "70%";
    modalOverlay.style.height = "70%";
    modalOverlay.style.zIndex = "1000"; // Ensure it sits on top

    modalOverlay.innerHTML = this.htmlContent;
    // Append modal overlay to body
    document.body.appendChild(modalOverlay);

    this.#loadMessages();
    // Add event listener to close the modal
    document.getElementById("closeModalBtn").addEventListener("click", () => {
      document.body.removeChild(modalOverlay); // Remove the modal from the DOM
    });
    // Close modal when clicking outside of modal content
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) {
        document.body.removeChild(modalOverlay); // Remove the modal from the DOM
      }
    });
    const itemsListHTML = document.getElementById("itemList");
    if (itemsListHTML) {
      // Add scroll event listener to load next page when scrolling past half
      itemsListHTML.addEventListener("scroll", () => {
        if (this.isLoading) return; // Prevent multiple concurrent loads
        const scrollPosition = itemsListHTML.scrollTop;
        const modalHeight =
          itemsListHTML.scrollHeight - itemsListHTML.clientHeight;
        // Load next page if scrolled past halfway
        if (scrollPosition >= modalHeight / 2) {
          this.isLoading = true;
          this.page += 1;
          this.#loadMessages();
        }
      });
    }
  }

  openPage(notification) {
    // Create a full-screen modal for the iframe
    const iframeModal = document.createElement("div");
    iframeModal.style.position = "fixed";
    iframeModal.style.top = "0";
    iframeModal.style.left = "0";
    iframeModal.style.width = "100%";
    iframeModal.style.height = "100%";
    iframeModal.style.zIndex = "1002"; // Ensure it sits above other content
    iframeModal.style.backgroundColor = "rgba(0, 0, 0, 0.5)"; // Dark background
    iframeModal.style.background = "red";
    // Create header for the iframe modal
    const modalHeader = document.createElement("div");
    modalHeader.style.display = "flex";
    modalHeader.style.justifyContent = "space-between";
    modalHeader.style.alignItems = "center";
    modalHeader.style.padding = "10px";
    modalHeader.style.color = "white";
    modalHeader.style.height = "20px";
    const headerTitle = document.createElement("h2");
    modalHeader.appendChild(headerTitle);
    const closeButton = document.createElement("div");
    closeButton.style.cursor = "pointer";
    closeButton.style.width = "24px";
    closeButton.style.height = "24px";
    closeButton.style.marginRight = "20px";
    closeButton.onclick = () => {
      document.body.removeChild(iframeModal); // Remove the modal from the DOM
    };
    closeButton.innerHTML = `
          <svg
            width="24"
            height="24"
            viewBox="0 0 95 95"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M47.5 0C21.266 0 0 21.266 0 47.5C0 73.734 21.266 95 47.5 95C73.734 95 95 73.734 95 47.5C94.9727 21.277 73.723 0.027 47.5 0ZM66.133 60.535C67.7072 62.0545 67.7502 64.5584 66.2307 66.1327C64.7112 67.7069 62.2073 67.7499 60.633 66.2304C60.6017 66.1991 60.5666 66.1679 60.5353 66.1327L47.5003 53.0977L34.4653 66.1327C32.8911 67.6522 30.3872 67.6093 28.8676 66.035C27.3871 64.4998 27.3871 62.0702 28.8676 60.535L41.9026 47.5L28.8676 34.465C27.3481 32.8908 27.391 30.3869 28.9653 28.8673C30.5005 27.3868 32.9301 27.3868 34.4653 28.8673L47.5003 41.9023L60.5353 28.8673C62.1095 27.3478 64.6134 27.3907 66.133 28.965C67.6135 30.5002 67.6135 32.9298 66.133 34.465L53.098 47.5L66.133 60.535Z"
              fill="white"
            />
          </svg>
        `;
    modalHeader.appendChild(closeButton);
    iframeModal.appendChild(modalHeader);
    // Create iframe
    const iframe = document.createElement("iframe");
    iframe.src = notification.access_url;
    iframe.style.width = "100%";
    iframe.style.height = "calc(100% - 20px)"; // Adjust height to account for header
    iframe.style.border = "none"; // Remove iframe border
    // Append header and iframe to modal
    iframeModal.appendChild(modalHeader);
    iframeModal.appendChild(iframe);
    // Append iframe modal to body
    document.body.appendChild(iframeModal);
    // // Mark the item as viewd
    // this.#markItemAsViewed(notification);
  }

  //   Private methods

  #markItemAsViewed(notification) {
    this.service.markMessageAsViewed(
      notification,
      (response) => {
        this.page = 1;
        this.#loadMessages();
      },
      (error) => {
        console.log("Grovs -- could not mark the message as viewed!");
      }
    );
  }

  #loadMessages() {
    const spinner = document.getElementById("spinner");
    spinner.style.display = "flex";
    this.isLoading = true;

    this.service.messagesForDevice(
      this.page,
      (response) => {
        spinner.style.display = "none";
        this.isLoading = false; // Reset loading state

        if (this.page == 1) {
          const itemList = document.getElementById("itemList");
          itemList.innerHTML = "";
        }

        this.#refreshItemsList(response.notifications);
      },
      (error) => {
        this.isLoading = false;
        spinner.style.display = "none";
        console.log("Grovs -- could not get messages!");
      }
    );
  }

  #refreshItemsList(items) {
    items.forEach((item) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "item";
      itemDiv.style.display = "flex";
      itemDiv.style.justifyContent = "space-between";
      itemDiv.style.alignItems = "center";
      itemDiv.style.padding = "20px";
      itemDiv.style.borderBottom = "1px solid rgba(255, 255, 255, 0.2)";
      itemDiv.style.cursor = "pointer";
      itemDiv.innerHTML = `
              <div class="list-item">
                  <div class="indicator" style="width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; display: ${
                    item.read ? "none" : "block"
                  }"></div>
                  <div class="list-title">
                    <strong class="item-title">${item.title}</strong><br />
                    <span class="item-subtitle">${item.subtitle}</span>
                  </div>
              </div>
              <svg width="10" height="20" viewBox="0 0 54 95" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M5.65 94.9627C4.25 94.9627 2.75 94.4627 1.65 93.3627C-0.55 91.1627 -0.55 87.6627 1.65 85.4627L39.55 47.4627L1.65 9.56272C-0.55 7.36272 -0.55 3.86272 1.65 1.66272C3.85 -0.537282 7.35 -0.537282 9.55 1.56272L51.45 43.4627C52.55 44.5627 53.05 45.9627 53.05 47.4627C53.05 48.9627 52.45 50.3627 51.45 51.4627L9.55 93.3627C8.45 94.4627 7.05 94.9627 5.65 94.9627Z" fill="white" fill-opacity="0.2"/>
  </svg>
  
  </span>
          `;
      itemDiv.onclick = () => {
        this.openPage(item);
      };
      itemList.appendChild(itemDiv);
    });
  }
}

export default GrovsUIHelper;
