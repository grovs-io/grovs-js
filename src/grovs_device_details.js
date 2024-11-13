// Define the GrovsDeviceDetails class
class GrovsDeviceDetails {
  /**
   * Helper function to check if running in Electron.
   * @returns {boolean} - True if in Electron, otherwise false.
   */
  static isElectron() {
    return (
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron")
    );
  }

  /**
   * Get current device details.
   * @returns {Object} - Object containing user agent, app version, and build.
   */
  static currentDetails() {
    const userAgent = navigator.userAgent;

    // Initialize return values object
    const returnValues = {
      user_agent: userAgent,
      app_version: "0",
      build: "0",
    };

    return returnValues;
  }

  /**
   * Get the value of a cookie or local storage item by name.
   * @param {string} name - Name of the item to retrieve.
   * @returns {string|null} - Value of the item, or null if not found.
   */
  static getValue(name) {
    if (this.isElectron()) {
      return localStorage.getItem(name); // Use local storage in Electron
    } else {
      const cookies = document.cookie.split(";"); // Split cookies into an array
      for (let cookie of cookies) {
        const [key, value] = cookie.trim().split("="); // Split each cookie into name and value
        if (key === name) {
          return decodeURIComponent(value); // Return the decoded cookie value
        }
      }
      return null; // Return null if the item is not found
    }
  }

  /**
   * Removes a cookie or local storage item by name.
   * @param {string} name - Name of the item to remove.
   */
  static removeValue(name) {
    if (this.isElectron()) {
      localStorage.removeItem(name); // Remove item from local storage in Electron
    } else {
      // Set the cookie's expiration date to the past
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }

  /**
   * Set a cookie or local storage item with the given name and value.
   * @param {string} name - Name of the item to set.
   * @param {string} value - Value to set for the item.
   */
  static setValue(name, value) {
    if (this.isElectron()) {
      localStorage.setItem(name, value); // Set value in local storage in Electron
    } else {
      // Set expiration date to a far-future date
      const farFutureDate = new Date("9999-12-31");
      const expires = "expires=" + farFutureDate.toUTCString();

      // Set the cookie
      document.cookie =
        name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/";
    }
  }

  /**
   * Get the value of the "Grovs" parameter from the current URL.
   * @returns {string|null} - Value of the "Grovs" parameter, or null if not found.
   */
  static getGrovsPath() {
    let urlWithoutFragment = window.location.href.split("#")[0];

    // Remove the trailing slash if it exists
    if (urlWithoutFragment.endsWith("/")) {
      urlWithoutFragment = urlWithoutFragment.slice(0, -1);
    }

    // Create a URL object with the cleaned URL
    const url = new URL(urlWithoutFragment);

    // Use URLSearchParams to get the 'Grovs' parameter
    const GrovsValue = url.searchParams.get("Grovs");

    // Decode the parameter value, if it exists
    const decodedGrovsValue = GrovsValue
      ? decodeURIComponent(GrovsValue)
      : null;

    if (decodedGrovsValue != null) {
      this.setValue("Grovs_path", decodedGrovsValue);

      return decodedGrovsValue;
    } else {
      // Return it only once
      const value = this.getValue("Grovs_path");
      this.removeValue("Grovs_path");

      return value;
    }
  }
}

// Export the GrovsDeviceDetails class
export default GrovsDeviceDetails;
