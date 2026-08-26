export enum TEMPLATE_WARNINGS_MSG {
  PARTIAL_OUTPUT = 'Some part of the recording could not be processed. Please review the output.',
  NO_RELEVANT_CONTENT = 'No relevant content for this output type was generated from the processed recording for this template.',
}

export enum ERROR_CODE {
  MICROPHONE = 'microphone',
  TXN_INIT_FAILED = 'txn_init_failed',
  TXN_LIMIT_EXCEEDED = 'txn_limit_exceeded',
  INTERNAL_SERVER_ERROR = 'internal_server_error',
  TXN_STOP_FAILED = 'txn_stop_failed',
  AUDIO_UPLOAD_FAILED = 'audio_upload_failed',
  INVALID_REQUEST = 'invalid_request',
  VAD_NOT_INITIALIZED = 'vad_not_initialized',
  NO_AUDIO_CAPTURE = 'no_audio_capture',
  SPEECH_DETECTED = 'speech_detected',
  TXN_STATUS_MISMATCH = 'txn_status_mismatch',
  LONG_SILENCE = 'long_silence',
}

export enum TEMPLATE_ERROR_MSG {
  DEFAULT = 'We encountered an unexpected error while generating your output.',
}

export enum MODEL_TYPE {
  PRO = 'pro',
  LITE = 'lite',
}

export enum TEMPLATE_TABS {
  MY_LIBRARY = 'my-library',
  EKA_TEMPLATE_DIRECTORY = 'eka-template-directory',
  CUSTOM_TEMPLATES = 'custom-templates',
  TEMPLATE_DIRECTORY = 'template-directory',
}

export enum MIXPANEL_EVENT_NAME {
  SCRIBEWEB_HOME = 'scribeweb_home',
  SCRIBEWEB_HOME_CLICKS = 'scribeweb_home_clicks',
  SCRIBEWEB_NEW_SESSION = 'scribeweb_new_session',
  SCRIBEWEB_SIDEBAR_CLICKS = 'scribeweb_sidebar_clicks',
  SCRIBEWEB_TEMPLATES_CLICKS = 'scribeweb_templates_clicks',
  SCRIBEWEB_API_WRAPPER = 'scribeweb_api_wrapper',
  SCRIBEWEB_ERRORS = 'scribeweb_errors',
  SCRIBEWEB_ONBOARD_PERSONALIZE = 'scribeweb_onboard_personalize',
  SCRIBEWEB_ONBOARD_PERSONALIZE_CLICKS = 'scribeweb_onboard_personalize_clicks',
  SCRIBEWEB_ONBOARD_WELCOME = 'scribeweb_onboard_welcome',
  SCRIBEWEB_ONBOARD_WELCOME_CLICKS = 'scribeweb_onboard_welcome_clicks',
  SCRIBEWEB_ONBOARD_SETUP = 'scribeweb_onboard_setup',
  SCRIBEWEB_ONBOARD_SETUP_CLICKS = 'scribeweb_onboard_setup_clicks',
  SCRIBEWEB_ONBOARD_COMPLETE = 'scribeweb_onboard_complete',
  SCRIBEWEB_ONBOARD_COMPLETE_CLICKS = 'scribeweb_onboard_complete_clicks',
  SCRIBEWEB_RESPONSE = 'scribeweb_response',
  SCRIBEWEB_SDK_CALLBACK = 'scribeweb_sdk_callback',
  SCRIBEWEB_FILE_UPLOAD_ERROR = 'scribeweb_file_upload_error',
  SCRIBEWEB_DESKTOP_INSTALL = 'scribeweb_desktop_install',
}

export enum MIXPANEL_EVENT_TYPE {
  START_RECORDING = 'start_recording',
  UPLOAD_RECORDING = 'upload_recording',
  NEW_SESSION = 'new_session',
  TEMPLATES = 'templates',
  PROFILE = 'profile',
  CREATE_TEMPLATE = 'create_template',
  GENERATE_TEMPLATE = 'generate_template',
  API_CALL = 'api_call',
  SDK_CALLBACK = 'sdk_callback',
  UNEXPECTED_ERROR = 'unexpected_error',
  SKIP = 'skip',
  SETUP = 'setup',
  SYSTEM_CHECKS = 'system_checks',
  START_NEW_SESSION = 'start_new_session',
  PAUSE_RECORDING = 'pause_recording',
  RESUME_RECORDING = 'resume_recording',
  END_RECORDING = 'end_recording',
  CANCEL_RECORDING = 'cancel_recording',
  EDIT_PREFERENCES = 'edit_preferences',
  ADD_TRANSCRIPT = 'add_transcript',
  MICROPHONE_CLICKS = 'microphone_clicks',
  WHATS_NEW = 'whats_new',
  WATCH_TUTORIAL = 'watch_tutorial',
}

export enum SESSION_PHASE {
  IDLE = 'idle',
  RECORDING = 'recording',
  PAUSED = 'paused',
  PROCESSING = 'processing',
  OUTPUT = 'output',
  ERROR = 'error',
}
