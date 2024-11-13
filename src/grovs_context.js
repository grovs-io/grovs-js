// Import the GrovsDeviceDetails module
import GrovsDeviceDetails from "./grovs_device_details";

// Define the GrovsContext class
class GrovsContext {
  // Static properties to store API key and Grovs ID
  /**
   * The API key used for authentication.
   * @type {string|null}
   */
  static API_KEY = null;

  /**
   * Indicates whether the application is running in a test environment.
   * @type {boolean}
   */
  static testEnvironment = false;

  static get linksquaredID() {
    return GrovsDeviceDetails.getValue("linksquared");
  }

  /**
   * Set Grovs ID cookie.
   * @param {string} id - Grovs ID to be stored in the cookie.
   */
  static setLinksquaredIDCookie(id) {
    GrovsDeviceDetails.setValue("linksquared", id);
  }

  /**
   * Static property to store the user identifier.
   * @type {string|null}
   */
  static USER_IDENTIFIER = null;

  /**
   * Static property to store the user attributes.
   * @type {Object|null}
   */
  static USER_ATTRIBUTES = null;
}

// Export the GrovsContext class
export default GrovsContext;
