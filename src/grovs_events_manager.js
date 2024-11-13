// Import necessary modules
import GrovsAPIService from "./grovs_api_service.js";
import GrovsDeviceDetails from "./grovs_device_details.js";

/**
 * Represents an event.
 */
class Event {
  /**
   * Constructs an Event instance.
   * @param {string} type - The type of the event.
   * @param {number} createdAt - The timestamp when the event occurred.
   * @param {string|null} [path=null] - The path associated with the event.
   * @param {number|null} [engagementTime=null] - The engagement time for the event.
   */
  constructor(type, createdAt, path = null, engagementTime = null) {
    this.type = type; // The type of the event
    this.createdAt = createdAt; // Timestamp of when the event occurred
    this.path = path; // The associated path for the event, default is null
    this.engagementTime = engagementTime; // Engagement time for the event, default is null
  }
}

/**
 * Manages the storage of events.
 */
class EventsStorage {
  /**
   * Constructs an EventsStorage instance.
   * Loads events from localStorage or initializes as an empty array.
   */
  constructor() {
    this.events = JSON.parse(localStorage.getItem("Grovs-events")) || [];
  }

  /**
   * Get all stored events.
   * @returns {Array} All stored events.
   */
  getEvents() {
    return this.events; // Return the array of stored events
  }

  /**
   * Store events to localStorage.
   */
  storeEventsLocally() {
    localStorage.setItem("Grovs-events", JSON.stringify(this.events)); // Store events array in localStorage
  }

  /**
   * Store a single event.
   * @param {Event} event - The event to store.
   */
  storeEvent(event) {
    this.events.push(event); // Add the event to the events array
    this.storeEventsLocally(); // Store the updated events array in localStorage
  }

  /**
   * Store multiple events.
   * @param {Array<Event>} events - Array of events to store.
   */
  storeEvents(events) {
    this.events.push(...events); // Add multiple events to the events array
    this.storeEventsLocally(); // Store the updated events array in localStorage
  }

  /**
   * Delete an event by object reference.
   * @param {Event} eventToDelete - The event to delete.
   */
  deleteEvent(eventToDelete) {
    this.events = this.events.filter((event) => event !== eventToDelete); // Filter out the event to delete
    this.storeEventsLocally(); // Store the updated events array in localStorage
  }

  /**
   * Get and remove all events.
   * @returns {Array} All stored events.
   */
  getAndRemoveAllEvents() {
    const eventsToReturn = this.events; // Store current events to return
    this.events = []; // Clear the events array
    this.storeEventsLocally(); // Store the empty array in localStorage
    return eventsToReturn; // Return the stored events
  }

  /**
   * Set timestamp to localStorage.
   * @param {number} timestamp - The timestamp to set.
   */
  setTimestamp(timestamp) {
    localStorage.setItem(
      "Grovs-events-timestamp",
      JSON.stringify(timestamp) // Store the timestamp in localStorage
    );
  }

  /**
   * Get timestamp from localStorage.
   * @returns {number|null} The timestamp from localStorage.
   */
  getTimestamp() {
    const storedTimestamp = localStorage.getItem(
      "Grovs-events-timestamp" // Retrieve timestamp from localStorage
    );
    return storedTimestamp ? JSON.parse(storedTimestamp) : null; // Return parsed timestamp or null if not found
  }
}

/**
 * Manages events and their handling.
 */
class GrovsEventsManager {
  /**
   * Constructs a GrovsEventsManager instance.
   * Initializes Grovs API service, EventsStorage, and lastTimestamp.
   */
  constructor() {
    this.service = new GrovsAPIService(); // Initialize Grovs API service
    this.eventsStorage = new EventsStorage(); // Initialize event storage
    this.lastTimestamp = Date.now(); // Set initial timestamp to current time

    const storedTimestamp = this.eventsStorage.getTimestamp(); // Get stored timestamp
    if (storedTimestamp) {
      this.setTimeSpent(); // Set time spent if stored timestamp exists
      this.lastTimestamp = storedTimestamp; // Update lastTimestamp to stored timestamp
    }

    this.eventsStorage.setTimestamp(this.lastTimestamp); // Set the current timestamp in storage
    this.handleFocus(); // Set up focus event listener
  }

  /**
   * Flush events to the server.
   */
  flushEvents() {
    this.flushEvents(); // Call the private flushEvents method to send events
  }

  /**
   * Add event.
   * @param {string} type - The type of the event.
   */
  addEvent(type) {
    const event = new Event(
      type,
      Date.now(), // Current timestamp for the event
      GrovsDeviceDetails.getGrovsPath(), // Path associated with the event
      null // Engagement time is initially null
    );
    this.eventsStorage.storeEvent(event); // Store the newly created event
  }

  /**
   * Add event and flush it to the server.
   * @param {string} type - The type of the event.
   */
  addEventWithFlush(type) {
    this.addEvent(type); // Add the event
    this.flushEvents(); // Flush events to the server
  }

  /**
   * Handle focus event when the window gains focus.
   * @private
   */
  handleFocus() {
    const self = this;
    window.addEventListener("focus", function () {
      self.setTimeSpent(); // Update time spent when the window gains focus
    });
  }

  /**
   * Set time spent on the current page.
   * @private
   */
  setTimeSpent() {
    const storedTimestamp = this.eventsStorage.getTimestamp(); // Retrieve the stored timestamp
    if (storedTimestamp) {
      const currentTimestamp = Date.now(); // Current timestamp
      const differenceInMilliseconds = Math.abs(
        currentTimestamp - this.lastTimestamp // Calculate time difference
      );
      const differenceInSeconds = Math.floor(differenceInMilliseconds / 1000); // Convert to seconds
      this.setSecondsToEvents(differenceInSeconds); // Update events with the calculated seconds
      this.eventsStorage.setTimestamp(null); // Clear the stored timestamp
    }
  }

  /**
   * Set engagement time (in seconds) to events.
   * @param {number} seconds - The seconds to set.
   * @private
   */
  setSecondsToEvents(seconds) {
    const events = this.eventsStorage.getAndRemoveAllEvents(); // Retrieve and clear stored events
    events.forEach((event) => {
      if (event.engagementTime == null) {
        event.engagementTime = seconds; // Set engagement time if not already set
      }
    });
    this.eventsStorage.storeEvents(events); // Store the updated events back in storage
  }

  /**
   * Flush events to the server by sending them and deleting locally.
   * @private
   */
  flushEvents() {
    this.setPathIfNeeded(); // Update event paths if needed
    const events = this.eventsStorage.getEvents(); // Retrieve all stored events
    events.forEach((event) => {
      this.sendAndDeleteEvent(event); // Send and delete each event
    });
  }

  /**
   * Set the path for events if it is not already set.
   * @private
   */
  setPathIfNeeded() {
    const path = GrovsDeviceDetails.getGrovsPath(); // Get the current path
    if (!path) {
      return; // Exit if no path is available
    }
    const events = this.eventsStorage.getAndRemoveAllEvents(); // Retrieve and clear stored events
    events.forEach((event) => {
      if (event.path == null) {
        event.path = path; // Set path for events if not already set
      }
    });
    this.eventsStorage.storeEvents(events); // Store updated events back in storage
  }

  /**
   * Send the event to the server and delete it from storage.
   * @param {Event} event - The event to send and delete.
   * @private
   */
  sendAndDeleteEvent(event) {
    const self = this;
    this.service.createEvent(
      event.type,
      event.createdAt,
      event.path,
      event.engagementTime,
      (response) => {
        self.eventsStorage.deleteEvent(event); // Delete the event after successful sending
      },
      (error) => {
        // Handle error if needed
      }
    );
  }
}

// Export the GrovsEventsManager class
export default GrovsEventsManager;
