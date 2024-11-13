import GrovsAPIService from "./grovs_api_service.js";
import GrovsEventsManager from "./grovs_events_manager.js";
import GrovsContext from "./grovs_context.js";
import GrovsDeviceDetails from "./grovs_device_details.js";
import GrovsUIHelper from "./grovs_ui_helper.js";

/**
 * Manages interactions with the Grovs API and event handling.
 */
class GrovsManager {
  /**
   * Creates an instance of GrovsManager.
   * @param {string} APIKey - The API key for authentication.
   * @param {boolean} testEnvironment - Indicates if the environment is a test environment.
   * @param {Function} linkHandlingCallback - Callback function to handle Grovs data.
   */
  constructor(APIKey, testEnvironment, linkHandlingCallback) {
    // Set API key and environment in the context
    GrovsContext.API_KEY = APIKey;
    GrovsContext.testEnvironment = testEnvironment;

    // Initialize callback for handling links
    this.linkHandlingCallback = linkHandlingCallback;
    // Initialize API service for making requests
    this.service = new GrovsAPIService();
    // Initialize event manager for handling events
    this.eventsManager = new GrovsEventsManager();
    // Authentication status
    this.authenticated = false;
    // Flag to determine if identifiers need updating
    this.shouldUpdateIdentifiers = false;
    // Initialize UI helper for UI interactions
    this.uiHelper = new GrovsUIHelper();
    // Array to store received data
    this.receivedData = [];
  }

  // MARK: Methods

  /**
   * Authenticates with the Grovs API.
   * @param {Function} succesfullAuthenticatedCallback - Callback function invoked upon successful authentication.
   */
  authenticate(succesfullAuthenticatedCallback) {
    // Get the current device details
    let details = GrovsDeviceDetails.currentDetails();

    const self = this; // Preserve context for callbacks
    this.service.authenticateDevice(
      details,
      /**
       * Success callback for authentication.
       * @param {Object} response - The authentication response.
       */
      (response) => {
        // Extract relevant data from response
        let linksquaredID = response.linksquared;
        let identifier = response.sdk_identifier;
        let attributes = response.sdk_attributes;

        // Set Grovs ID cookie for future use
        GrovsContext.setLinksquaredIDCookie(linksquaredID);

        // Update context attributes only if identifiers are not being updated
        if (!self.shouldUpdateIdentifiers) {
          GrovsContext.USER_ATTRIBUTES = identifier;
          GrovsContext.USER_IDENTIFIER = attributes;
        }

        // Mark as authenticated
        self.authenticated = true;

        // Call the success callback if provided
        if (succesfullAuthenticatedCallback) {
          succesfullAuthenticatedCallback();
        }

        // Handle data fetching and event flushing
        self.#handleFetchData();
        self.#updateUserAttributesIfNeeded();
        self.eventsManager.flushEvents();
      },
      /**
       * Error callback for authentication.
       * @param {Object} error - The authentication error.
       */
      (error) => {
        console.log(error);
        console.log("Grovs - wrong credentials, the SDK will NOT work!");
      }
    );
  }

  /**
   * Sets the user identifier.
   * @param {string} identifier - The user identifier.
   */
  setUserIdentifier(identifier) {
    GrovsContext.USER_IDENTIFIER = identifier;

    // Mark for identifier update if not authenticated
    if (!this.authenticated) {
      this.shouldUpdateIdentifiers = true;
    }

    this.#updateUserAttributesIfNeeded();
  }

  /**
   * Sets the user attributes.
   * @param {Object} attributes - A dictionary of user attributes.
   */
  setUserAttributes(attributes) {
    GrovsContext.USER_ATTRIBUTES = attributes;

    // Mark for identifier update if not authenticated
    if (!this.authenticated) {
      this.shouldUpdateIdentifiers = true;
    }

    this.#updateUserAttributesIfNeeded();
  }

  /**
   * Retrieves the user identifier from the GrovsContext.
   * @returns {string|null} The user identifier. Null if not authenticated.
   */
  userIdentifier() {
    return GrovsContext.USER_IDENTIFIER;
  }

  /**
   * Retrieves the user attributes from the GrovsContext.
   * @returns {Object|null} The user attributes. Null if not authenticated.
   */
  userAttributes() {
    return GrovsContext.USER_ATTRIBUTES;
  }

  /**
   * Creates a link with the Grovs API.
   * @param {string} title - The title of the link.
   * @param {string} subtitle - The subtitle of the link.
   * @param {string} imageURL - The URL of the image associated with the link.
   * @param {Object} data - Additional data for the link.
   * @param {Function} success - Success callback for creating the link.
   * @param {Function} error - Error callback for creating the link.
   */
  createLink(title, subtitle, imageURL, data, success, error) {
    // Check if authenticated before creating a link
    if (!this.authenticated) {
      error("The Grovs SDK is not yet initialized, try again later!");
    }

    this.service.createLink(
      title,
      subtitle,
      imageURL,
      data,
      /**
       * Success callback for creating the link.
       * @param {Object} response - The response from creating the link.
       */
      (response) => {
        if (response.link) {
          success(response.link);
          return;
        }

        // Error handling for link creation
        error(
          "You must configure the redirect rules in the Web interface first"
        );
      },
      error // Error callback for the service
    );
  }

  /**
   * Displays the messages list using the UI helper.
   */
  showMessagesList() {
    this.uiHelper.showMessagesList();
  }

  /**
   * Retrieves messages for the device.
   * @param {number} page - The page number for pagination.
   * @param {Function} response - Success callback for retrieving messages.
   * @param {Function} error - Error callback for retrieving messages.
   */
  getMessages(page, response, error) {
    this.service.messagesForDevice(page, response, error);
  }

  /**
   * Retrieves the number of unread messages.
   * @param {Function} response - Success callback for the number of unread messages.
   * @param {Function} error - Error callback for retrieving the count.
   */
  getNumberOfUnreadMessages(response, error) {
    this.service.numberOfUnreadMessages(response, error);
  }

  /**
   * Returns all the received data.
   * @returns {Array} Array of all received data objects.
   */
  getAllReceivedData() {
    return this.receivedData;
  }

  /**
   * Marks a message as read.
   * @param {Object} message - The message to mark as read.
   * @param {Function} response - Success callback for marking the message.
   * @param {Function} error - Error callback for marking the message.
   */
  markMessageAsRead(message, response, error) {
    this.service.markMessageAsViewed(message, response, error);
  }

  // MARK: Private

  /**
   * Displays automatic messages by fetching them from the service.
   * @private
   */
  #displayAutomaticMessages() {
    this.service.messagesForAutomaticDisplay(
      (response) => {
        // Disabled for now
        // const notifications = response.notifications;
        // notifications.forEach((item) => {
        //   this.uiHelper.openPage(item);
        // });
      },
      (error) => {
        console.log("Grovs -- could not get automatic notifications!");
      }
    );
  }

  /**
   * Handles fetching data from Grovs API.
   * Determines whether to fetch data for the current device or a specific path.
   * @private
   */
  #handleFetchData() {
    const GrovsValue = GrovsDeviceDetails.getGrovsPath();
    console.log("Grovs - value extracted from the link", GrovsValue);
    // Check if a specific path is set
    if (GrovsValue) {
      this.#handleGrovsValue(GrovsValue);
    } else {
      this.#handleDataForDevice();
    }

    // Fetch automatic messages
    this.#displayAutomaticMessages();
  }

  /**
   * Handles fetching data for a specific path from Grovs API.
   * @param {string} path - The path for which to fetch data.
   * @private
   */
  #handleGrovsValue(path) {
    let details = GrovsDeviceDetails.currentDetails();
    this.service.payloadForDeviceAndPath(
      details,
      path,
      /**
       * Success callback for fetching data for a specific path.
       * @param {Object} response - The response data.
       */
      (response) => {
        this.#handleDataReceived(response.data);
      },
      /**
       * Error callback for fetching data for a specific path.
       * @param {Object} error - The error object.
       */
      (error) => {
        console.log("Grovs -- could not fetch data!");
      }
    );
  }

  /**
   * Handles fetching data for the current device from Grovs API.
   * @private
   */
  #handleDataForDevice() {
    let details = GrovsDeviceDetails.currentDetails();
    const self = this; // Preserve context for callbacks

    this.service.payloadForDevice(
      details,
      /**
       * Success callback for fetching data for the current device.
       * @param {Object} response - The response data.
       */
      (response) => {
        self.#handleDataReceived(response.data);
      },
      /**
       * Error callback for fetching data for the current device.
       * @param {Object} error - The error object.
       */
      (error) => {
        console.log("Grovs -- could not fetch data!");
      }
    );
  }

  /**
   * Handles received data from Grovs API.
   * @param {Object} data - The received data.
   * @private
   */
  #handleDataReceived(data) {
    if (data) {
      // Store received data and invoke callback
      this.receivedData.push(data);
      this.linkHandlingCallback(data);
    }
  }

  /**
   * Updates user attributes if authenticated.
   * @private
   */
  #updateUserAttributesIfNeeded() {
    if (!this.authenticated) {
      return; // Do nothing if not authenticated
    }

    const self = this; // Preserve context for callbacks
    this.service.setUserAttributes(
      (response) => {
        self.shouldUpdateIdentifiers = false; // Reset update flag
      },
      /**
       * Error callback for updating user attributes.
       * @param {Object} error - The error object.
       */
      (error) => {
        console.log("Grovs -- could not set identifiers!");
      }
    );
  }
}

export default GrovsManager;
