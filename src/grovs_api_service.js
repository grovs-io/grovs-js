// Import the helper class for making API requests
import GrovsAPIServiceHelper from "./grovs_api_service_helper";
import GrovsContext from "./grovs_context";

// Define the Grovs API service class
class GrovsAPIService {
  // Define endpoint paths as static properties
  static ENDPOINTS = {
    AUTHENTICATE: "/authenticate",
    PAYLOAD: "/data_for_device",
    CREATE_EVENT: "/event",
    CREATE_LINK: "/create_link",
    USER_ATTRIBUTES: "/visitor_attributes",
    PAYLOAD_FOR_DEVICE_AND_PATH: "/data_for_device_and_path",
    NOTIFICATIONS_FOR_DEVICE: "/notifications_for_device",
    MARK_NOTIFICATION_AS_READ: "/mark_notification_as_read",
    NOTIFICATIONS_TO_DISPLAY_AUTOMATICALLY:
      "/notifications_to_display_automatically",
    NUMBER_OF_UNREAD_MESSAGES: "/number_of_unread_notifications",
  };

  // Constructor to initialize the API service helper
  constructor() {
    this.apiService = new GrovsAPIServiceHelper();
  }

  // Method to authenticate a device
  authenticateDevice(details, response, error) {
    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.AUTHENTICATE,
      details,
      response,
      error
    );
  }

  // Method to fetch payload for a device
  payloadForDevice(details, response, error) {
    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.PAYLOAD,
      details,
      response,
      error
    );
  }

  // Method to fetch payload for a device and path
  payloadForDeviceAndPath(details, path, response, error) {
    const dataToSend = { ...details, path };
    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.PAYLOAD_FOR_DEVICE_AND_PATH,
      dataToSend,
      response,
      error
    );
  }

  // Method to create an event
  createEvent(event, createdAt, path, engagementTime, response, error) {
    const data = { event };
    if (path) data.path = path;
    if (engagementTime) data.engagement_time = engagementTime;

    const isoDate = new Date(createdAt).toISOString();
    data.created_at = isoDate;

    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.CREATE_EVENT,
      data,
      response,
      error
    );
  }

  // Method to create a link
  createLink(title, subtitle, imageUrl, data, response, error) {
    const dataToSend = {};
    if (title) dataToSend.title = title;
    if (subtitle) dataToSend.subtitle = subtitle;
    if (imageUrl) dataToSend.image_url = imageUrl;
    if (data) dataToSend.data = JSON.stringify(data);

    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.CREATE_LINK,
      dataToSend,
      response,
      error
    );
  }

  // Method to set attributes
  setUserAttributes(response, error) {
    const dataToSend = {};
    dataToSend.sdk_identifier = GrovsContext.USER_IDENTIFIER;
    if (GrovsContext.USER_ATTRIBUTES) {
      dataToSend.sdk_attributes = GrovsContext.USER_ATTRIBUTES;
    }

    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.USER_ATTRIBUTES,
      dataToSend,
      response,
      error
    );
  }

  messagesForDevice(page, response, error) {
    const dataToSend = { page: page };

    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.NOTIFICATIONS_FOR_DEVICE,
      dataToSend,
      response,
      error
    );
  }

  markMessageAsViewed(message, response, error) {
    const dataToSend = { id: message.id };
    this.apiService.POST(
      GrovsAPIService.ENDPOINTS.MARK_NOTIFICATION_AS_READ,
      dataToSend,
      response,
      error
    );
  }

  messagesForAutomaticDisplay(response, error) {
    this.apiService.GET(
      GrovsAPIService.ENDPOINTS.NOTIFICATIONS_TO_DISPLAY_AUTOMATICALLY,
      null,
      response,
      error
    );
  }

  numberOfUnreadMessages(response, error) {
    this.apiService.GET(
      GrovsAPIService.ENDPOINTS.NUMBER_OF_UNREAD_MESSAGES,
      null,
      response,
      error
    );
  }
}

// Export the GrovsAPIService class
export default GrovsAPIService;
