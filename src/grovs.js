import GrovsManager from "./grovs_manager.js";

/**
 * Entry point for the Grovs SDK.
 * Provides methods to initialize and interact with the SDK.
 */
class Grovs {
  /**
   * Creates an instance of the Grovs SDK.
   * @param {string} APIKey - The API key for authentication.
   * @param {boolean} testEnvironment - Indicates if the environment is a test environment.
   * @param {Function} linkHandlingCallback - Callback function to handle Grovs data.
   */
  constructor(APIKey, testEnvironment, linkHandlingCallback) {
    // Initialize the GrovsManager with the provided API key and callback
    this.manager = new GrovsManager(
      APIKey,
      testEnvironment,
      linkHandlingCallback
    );
  }

  /**
   * Starts the Grovs SDK by authenticating with the API.
   * Optionally takes a callback that is called upon successful authentication.
   * @param {Function} [succesfullAuthenticatedCallback=null] - Callback to invoke on successful authentication.
   */
  start(succesfullAuthenticatedCallback = null) {
    // Start authentication process
    this.manager.authenticate(succesfullAuthenticatedCallback);
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
    // Delegate link creation to the manager
    this.manager.createLink(title, subtitle, imageURL, data, success, error);
  }

  /**
   * Retrieves the user identifier from the manager.
   * @returns {string|null} The user identifier, or null if not set.
   */
  userIdentifier() {
    // Get user identifier from the manager
    return this.manager.userIdentifier();
  }

  /**
   * Retrieves the user attributes from the manager.
   * @returns {Object|null} The user attributes, or null if not set.
   */
  userAttributes() {
    // Get user attributes from the manager
    return this.manager.userAttributes();
  }

  /**
   * Sets the user identifier in the manager.
   * @param {string} identifier - The user identifier to set.
   * @returns {void}
   */
  setUserIdentifier(identifier) {
    // Set user identifier through the manager
    this.manager.setUserIdentifier(identifier);
  }

  /**
   * Sets the user attributes in the manager.
   * @param {Object} attributes - A dictionary of user attributes to set.
   * @returns {void}
   */
  setUserAttributes(attributes) {
    // Set user attributes through the manager
    this.manager.setUserAttributes(attributes);
  }

  /**
   * Checks if the SDK is authenticated.
   * This method returns the authentication status of the SDK.
   * @returns {boolean} - The authentication status of the manager.
   */
  authenticated() {
    // Return the authentication status from the manager
    return this.manager.authenticated;
  }

  /**
   * Displays the messages list using the manager.
   * This method triggers the display of the messages list in the UI.
   * @returns {void}
   */
  showMessagesList() {
    // Delegate message list display to the manager
    this.manager.showMessagesList();
  }

  /**
   * Retrieves messages for a specific page using the manager.
   * @param {number} page - The page number to retrieve messages from.
   * @param {Function} response - Callback to handle the retrieved messages.
   * @param {Function} error - Callback to handle any errors during retrieval.
   * @returns {void}
   */
  getMessages(page, response, error) {
    // Delegate message retrieval to the manager
    this.manager.getMessages(page, response, error);
  }

  /**
   * Retrieves the number of unread messages using the manager.
   * @param {Function} response - Callback to handle the count of unread messages.
   * @param {Function} error - Callback to handle any errors during retrieval.
   * @returns {void}
   */
  getNumberOfUnreadMessages(response, error) {
    // Delegate unread message count retrieval to the manager
    this.manager.getNumberOfUnreadMessages(response, error);
  }

  /**
   * Returns all the received data since startup.
   * @returns {Array} Array of all received data objects.
   */
  getAllReceivedData() {
    // Return received data from the manager
    return this.manager.getAllReceivedData();
  }

  /**
   * Marks a message as read.
   * @param {Object} message - The message to be marked as read.
   * @param {Function} response - Callback for success.
   * @param {Function} error - Callback for error.
   * @returns {void}
   */
  markMessageAsRead(message, response, error) {
    // Delegate marking message as read to the manager
    this.manager.markMessageAsRead(message, response, error);
  }
}

export default Grovs;
