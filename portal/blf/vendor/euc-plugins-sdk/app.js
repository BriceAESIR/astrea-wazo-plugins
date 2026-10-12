import { EVENT_ON_LOADED, EVENT_APP_UNLOADED, EVENT_PLUGIN_UNLOADED, EVENT_APP_INITIALIZE, EVENT_ON_LOGOUT, EVENT_SEND_IFRAME_MESSAGE, EVENT_SEND_BACKGROUND_MESSAGE, EVENT_ON_IFRAME_MESSAGE, EVENT_ON_BACKGROUND_MESSAGE, EVENT_CLOSE_LEFT_PANEL, EVENT_OPEN_LEFT_PANEL, EVENT_START_CALL, EVENT_ON_CALL_INCOMING, EVENT_ON_CALL_MADE, EVENT_ON_CALL_ANSWERED, EVENT_ON_CALL_ACCEPTED, EVENT_ON_CALL_HUNG_UP, EVENT_OPEN_LINK, EVENT_CREATE_MEETING, EVENT_OPEN_MEETING_LOBBY, EVENT_ON_MEETING_CREATED, EVENT_ROUTE_CHANGE, EVENT_WS_MESSAGE, EVENT_PLAY_PROGRESS_SOUND, EVENT_PLAY_NEW_MESSAGE_SOUND, EVENT_PLAY_INCOMING_CALL_SOUND, EVENT_PLAY_DOUBLE_CALL_SOUND, EVENT_PLAY_HANGUP_SOUND, EVENT_STOP_CURRENT_SOUND, EVENT_CONFIGURE_SOUNDS, EVENT_RESET_SOUNDS, EVENT_DISPLAY_NOTIFICATION, EVENT_CHANGE_NAVBAR_COLOR, EVENT_RESET_NAVBAR_COLOR, EVENT_DISPLAY_MODAL, EVENT_REMOVE_MODAL, EVENT_USER_JOIN_ROOM, EVENT_USER_LEAVE_ROOM, EVENT_PARTICIPANT_JOIN_ROOM, EVENT_PARTICIPANT_LEAVE_ROOM, EVENT_IGNORE_CALL, EVENT_ON_NEW_SESSION, EVENT_UPDATE_BADGE, EVENT_ON_CONNECTED_TO_STACK, EVENT_ON_SWITCH_STACK_TENANT, EVENT_CHANGE_TOOLBAR_DISPLAY, EVENT_SWITCH_PORTAL_RESELLER, EVENT_SWITCH_STACK_LOCATION, EVENT_MOBILE_HEADER, EVENT_MOBILE_CONTEXTUAL_MENU, EVENT_MOBILE_SHOW_BOTTOM_NAV, EVENT_MOBILE_ON_MENU_ACTION, EVENT_MOBILE_ON_HEADER_BACK, EVENT_DISPLAY_BANNER, EVENT_REMOVE_BANNER, } from './constants.js';
const initializationTimeoutInMs = 5000;
export class App {
    constructor() {
        // Global
        this.onNewSession = (session) => { };
        this.onUnLoaded = (e) => { };
        this.onPluginUnLoaded = () => { };
        this.onAppUnLoaded = (tabId) => { };
        this.onIframeMessage = (message) => { };
        this.onBackgroundMessage = (message) => { };
        // WDA
        this.onLogout = () => { };
        this.onCallIncoming = (call) => { };
        this.onCallMade = (call) => { };
        this.onCallAnswered = (call) => { };
        this.onCallAccepted = (call) => { };
        this.onCallHungUp = (call) => { };
        this.onUnHandledEvent = (event) => { };
        this.onWebsocketMessage = (message) => { };
        this.onMeetingCreated = (meeting) => { };
        this.onRouteChanged = (location, action) => { };
        this.onUserJoinRoom = (room) => { };
        this.onUserLeaveRoom = (room) => { };
        this.onParticipantJoinRoom = (room, participant) => { };
        this.onParticipantLeaveRoom = (room, participant) => { };
        // Portal
        this.onConnectedToStack = (stackSession) => { };
        this.onSwitchTenant = (uuid, name) => { };
        this.initialize = async () => {
            if (this.isInitialized()) {
                return Promise.resolve();
            }
            window.addEventListener('message', this._onMessage, false);
            return new Promise((resolve, reject) => {
                this._sendMessage(EVENT_APP_INITIALIZE, { bg: this._isBackground, pluginId: this._pluginId });
                this._initializeTimeout = setTimeout(() => {
                    this._initializeTimeout = null;
                    reject('SDK initialize timeout');
                }, initializationTimeoutInMs);
                this._initializeResolve = resolve;
            });
        };
        this.isInitialized = () => {
            return this._initializeCompleted;
        };
        // Global
        this.getContext = () => this.context;
        this.sendMessageToIframe = (payload) => this._sendMessage(EVENT_SEND_IFRAME_MESSAGE, { payload });
        this.sendMessageToBackground = (payload) => this._sendMessage(EVENT_SEND_BACKGROUND_MESSAGE, { payload });
        // WDA
        this.startCall = ({ targets, requestedModalities = ['audio'] }) => {
            this._sendMessage(EVENT_START_CALL, { targets, requestedModalities });
        };
        this.openLink = (url) => {
            this._sendMessage(EVENT_OPEN_LINK, { url });
        };
        this.createMeeting = (name, requireAuthorization = false, persistent = false) => {
            this._sendMessage(EVENT_CREATE_MEETING, { name, requireAuthorization, persistent });
        };
        this.openMeetingLobby = (extension) => {
            this._sendMessage(EVENT_OPEN_MEETING_LOBBY, { extension });
        };
        this.openSettings = () => {
            // @TODO: Fix it in WDA
            // this._sendMessage(EVENT_OPEN_SETTINGS);
        };
        this.closeLeftPanel = () => this._sendMessage(EVENT_CLOSE_LEFT_PANEL);
        this.openLeftPanel = () => this._sendMessage(EVENT_OPEN_LEFT_PANEL);
        this.playProgressSound = () => this._sendMessage(EVENT_PLAY_PROGRESS_SOUND);
        this.playNewMessageSound = () => this._sendMessage(EVENT_PLAY_NEW_MESSAGE_SOUND);
        this.playIncomingCallSound = () => this._sendMessage(EVENT_PLAY_INCOMING_CALL_SOUND);
        this.playDoubleCallSound = () => this._sendMessage(EVENT_PLAY_DOUBLE_CALL_SOUND);
        this.playHangupSound = () => this._sendMessage(EVENT_PLAY_HANGUP_SOUND);
        this.stopCurrentSound = () => this._sendMessage(EVENT_STOP_CURRENT_SOUND);
        this.configureSounds = (sounds) => this._sendMessage(EVENT_CONFIGURE_SOUNDS, { sounds });
        this.resetSounds = () => this._sendMessage(EVENT_RESET_SOUNDS);
        this.changeNavBarColor = (color) => this._sendMessage(EVENT_CHANGE_NAVBAR_COLOR, { color });
        this.resetNavBarColor = () => this._sendMessage(EVENT_RESET_NAVBAR_COLOR);
        this.displayNotification = (title, text) => this._sendMessage(EVENT_DISPLAY_NOTIFICATION, { title, text });
        this.displayModal = ({ url, title, text, htmlText, height, width, hideCloseButton }) => this._sendMessage(EVENT_DISPLAY_MODAL, { url, title, text, htmlText, height, width, hideCloseButton });
        this.removeModal = () => this._sendMessage(EVENT_REMOVE_MODAL);
        this.hasLocalVideoStream = (call) => Wazo.Phone.phone.hasALocalVideoTrack(call);
        this.getLocalCurrentVideoStream = (call) => Wazo.Phone.phone.getLocalVideoStream(call);
        this.hasRemoveVideoStream = (call) => Wazo.Phone.phone.hasRemoteVideo(call);
        this.getRemoteVideoStream = (call) => Wazo.Phone.phone.getRemoteVideoStream(call);
        this.updateBadge = (args) => this._sendMessage(EVENT_UPDATE_BADGE, { ...args, entityId: args.entityId || this._entityId || 'update-badge-null-entity-id' });
        this.displayBanner = (args) => this._sendMessage(EVENT_DISPLAY_BANNER, { ...args, entityId: this._entityId || 'display-banner-null-entity-id' });
        this.closeBanner = () => this._sendMessage(EVENT_REMOVE_BANNER, { entityId: this._entityId || 'remove-banner-null-entity-id' });
        // Portal
        this.changeToolbarDisplay = (display) => this._sendMessage(EVENT_CHANGE_TOOLBAR_DISPLAY, { display });
        this.switchPortalReseller = (uuid) => this._sendMessage(EVENT_SWITCH_PORTAL_RESELLER, { reseller: { uuid } });
        this.switchStackLocation = (uuid) => this._sendMessage(EVENT_SWITCH_STACK_LOCATION, { location: { uuid } });
        // App to Mobile
        this.setMobileHeader = ({ title, callback }, entityId) => {
            const id = entityId || this._entityId;
            if (id) {
                delete this._headerBackCallbacks[id];
                if (typeof callback === 'function') {
                    this._headerBackCallbacks[id] = callback;
                }
            }
            this._sendMessage(EVENT_MOBILE_HEADER, {
                headerTitle: title,
                emitHeaderBack: !!callback,
                entityId: entityId || this._entityId,
            });
        };
        // @WIP
        this.setMobileContextualMenu = (contextualMenu, entityId) => this._sendMessage(EVENT_MOBILE_CONTEXTUAL_MENU, { contextualMenu, entityId: entityId || this._entityId });
        // @WIP
        this.setMobileShowBottomNav = (showBottomNav, entityId) => this._sendMessage(EVENT_MOBILE_SHOW_BOTTOM_NAV, { showBottomNav, entityId: entityId || this._entityId });
        // Mobile to app
        // @WIP
        this.onMobileMenuAction = (id) => this.sendMessageToIframe({ type: EVENT_MOBILE_ON_MENU_ACTION, id });
        this._onMessage = (event) => {
            if (!event.data) {
                return;
            }
            switch (event.data.type) {
                // Global
                case EVENT_ON_LOADED:
                    this._onLoaded(event.data.session, event.data.theme, event.data.locale, event.data.extra);
                    break;
                case EVENT_APP_UNLOADED:
                    delete this._headerBackCallbacks[event.data.tabId];
                    this.onAppUnLoaded(event.data.tabId);
                    break;
                case EVENT_PLUGIN_UNLOADED:
                    this._unloadPlugin();
                    break;
                case EVENT_ON_LOGOUT:
                    this.onLogout();
                    this._unloadPlugin();
                    break;
                case EVENT_ON_NEW_SESSION:
                    this.onNewSession(event.data.session);
                    break;
                case EVENT_ON_IFRAME_MESSAGE:
                    if (event.data._pluginId === this._pluginId) {
                        this.onIframeMessage(event.data.payload);
                    }
                    break;
                case EVENT_ON_BACKGROUND_MESSAGE:
                    if (event.data._pluginId === this._pluginId) {
                        this.onBackgroundMessage(event.data.payload);
                    }
                    break;
                case EVENT_USER_JOIN_ROOM:
                    this.onUserJoinRoom(event.data.room);
                    break;
                case EVENT_USER_LEAVE_ROOM:
                    this.onUserLeaveRoom(event.data.room);
                    break;
                case EVENT_PARTICIPANT_JOIN_ROOM:
                    this.onParticipantJoinRoom(event.data.room, event.data.participant);
                    break;
                case EVENT_PARTICIPANT_LEAVE_ROOM:
                    this.onParticipantLeaveRoom(event.data.room, event.data.participant);
                    break;
                // WDA
                case EVENT_WS_MESSAGE:
                    this.onWebsocketMessage(event.data.message);
                    break;
                case EVENT_ON_MEETING_CREATED:
                    this.onMeetingCreated(event.data.meeting);
                    break;
                case EVENT_ROUTE_CHANGE:
                    this.onRouteChanged(event.data.location, event.data.action);
                    break;
                case EVENT_ON_CALL_INCOMING:
                    this.onCallIncoming(event.data.call);
                    break;
                case EVENT_ON_CALL_MADE:
                    this.onCallMade(event.data.call);
                    break;
                case EVENT_ON_CALL_ANSWERED:
                    this.onCallAnswered(event.data.call);
                    break;
                case EVENT_ON_CALL_ACCEPTED:
                    this.onCallAccepted(event.data.call);
                    break;
                case EVENT_ON_CALL_HUNG_UP:
                    this.onCallHungUp(event.data.call);
                    break;
                // Portal
                case EVENT_ON_CONNECTED_TO_STACK:
                    this.onConnectedToStack(event.data.stackSession);
                    break;
                case EVENT_ON_SWITCH_STACK_TENANT:
                    this.onSwitchTenant(event.data.tenant.uuid, event.data.tenant.name);
                    break;
                // Mobile
                case EVENT_MOBILE_ON_HEADER_BACK:
                    const action = this._headerBackCallbacks[event.data.entityId || this._entityId];
                    if (typeof action === 'function') {
                        action();
                    }
                    break;
                case EVENT_MOBILE_ON_MENU_ACTION:
                    this.onMobileMenuAction(event.data);
                    break;
                default:
                    this.onUnHandledEvent(event);
                    break;
            }
        };
        this._sendMessage = (type, payload = {}) => {
            if (!this.isInitialized() && type !== EVENT_APP_INITIALIZE) {
                this._queuedMessages.push({ type, payload });
                return;
            }
            // @ts-ignore
            if (window.ReactNativeWebView) {
                // @ts-ignore (Mobile)
                return window.ReactNativeWebView.postMessage(JSON.stringify({ type, _pluginId: this._pluginId, _entityId: this._entityId, ...payload }));
            }
            window.parent.postMessage({ type, _pluginId: this._pluginId, _entityId: this._entityId, ...payload }, '*');
        };
        this._sendQueuedMessages = () => {
            this._queuedMessages.forEach(({ type, payload }) => {
                this._sendMessage(type, payload);
            });
        };
        this._onLoaded = (session, theme, locale, extra) => {
            if (this._initializeTimeout === null || this.isInitialized()) {
                return;
            }
            clearTimeout(this._initializeTimeout);
            this._initializeCompleted = true;
            this.context.app = {
                locale,
                theme,
                host: {
                    clientType: extra ? extra.clientType : null,
                },
                extra: {
                    ...extra,
                    baseUrl: this._baseUrl,
                    pluginId: this._pluginId,
                },
            };
            this.context.user = session;
            if (this._initializeResolve) {
                this._initializeResolve();
            }
            this._sendQueuedMessages();
        };
        // Deprecated, we should use `_configurePlugin` instead
        this._setPluginId = (pluginId) => {
            this._pluginId = pluginId;
        };
        this._unloadPlugin = () => {
            this.onPluginUnLoaded();
            this._resetEvents();
        };
        this._configurePlugin = (configuration) => {
            if (configuration.pluginId) {
                this._pluginId = configuration.pluginId;
            }
            if (configuration.baseUrl) {
                this._baseUrl = configuration.baseUrl;
            }
            if (configuration.entityId) {
                this._entityId = configuration.entityId;
            }
        };
        this._resetEvents = () => {
            this.onUnLoaded = (e) => { };
            this.onPluginUnLoaded = () => { };
            this.onAppUnLoaded = (tabId) => { };
            this.onIframeMessage = (message) => { };
            this.onBackgroundMessage = (message) => { };
            // WDA
            this.onLogout = () => { };
            this.onNewSession = (session) => { };
            this.onCallIncoming = (call) => { };
            this.onCallMade = (call) => { };
            this.onCallAnswered = (call) => { };
            this.onCallAccepted = (call) => { };
            this.onCallHungUp = (call) => { };
            this.onUnHandledEvent = (event) => { };
            this.onWebsocketMessage = (message) => { };
            this.onMeetingCreated = (meeting) => { };
            this.onRouteChanged = (location, action) => { };
            // Portal
            this.onConnectedToStack = (stackSession) => { };
            this.onSwitchTenant = (uuid, name) => { };
        };
        this._resetEvents();
        this._initializeCompleted = false;
        this._initializeResolve = null;
        this._initializeTimeout = null;
        this._pluginId = globalThis?.pluginId || null;
        this._baseUrl = null;
        this._entityId = null;
        this._isBackground = !window.name;
        this._queuedMessages = [];
        this._headerBackCallbacks = {};
        this.context = {
            app: {
                locale: null,
                theme: null,
                host: {
                    clientType: null,
                },
                extra: null,
            },
        };
        // Can't be simplified as `window.onunload = this.onUnLoaded`
        // because `this.onUnLoaded` might not have been overridden by the module yet.
        window.onunload = (e) => {
            this.onUnLoaded(e);
        };
        // Used to fetch pluginId when loaded in an iframe
        if (window.name) {
            try {
                // Is window.name a valid JSON ?
                this._configurePlugin(JSON.parse(window.name));
            }
            catch (_) {
                // Deprecated way to do it, remove it in future version
                this._configurePlugin({ pluginId: window.name });
            }
        }
        // We expose a global method to be used in the <script> tag directly after importing the `backgroundScript` url
        // Also used in mobile
        globalThis._setPluginId = this._setPluginId;
        globalThis._configurePlugin = this._configurePlugin;
    }
    ignoreCall(call) {
        this._sendMessage(EVENT_IGNORE_CALL, { call });
    }
}
// @deprecated: can conflict with other app when using the instance directly
export default new App();
