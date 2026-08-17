import { marked } from "/marked.min.js";
import { Fragment, Teleport, computed, createApp, createBlock, createCommentVNode, createElementBlock, createElementVNode, createTextVNode, createVNode, defineComponent, guardReactiveProps, inject, mergeProps, nextTick, normalizeClass, normalizeProps, normalizeStyle, onMounted, onUnmounted, openBlock, reactive, ref, renderList, resolveDynamicComponent, shallowReactive, toDisplayString, toHandlers, unref, useTemplateRef, watch, watchEffect, withCtx, withKeys, withModifiers } from "/vue.runtime.min.js";
import DOMPurify from "/dompurify.min.js";
//#region src/features/journey-state.ts
/** Every event loaded so far, oldest page first — 'Load more' appends. */
var journeyEvents = ref([]);
/** 'loading' | 'error' | 'empty' | 'ready'. */
var journeyPhase = ref("loading");
/** The active journey filter. Reassigned wholesale so the island re-derives. */
var journeyFilter = ref({
	agent: "",
	kind: "",
	skill: ""
});
//#endregion
//#region src/features/settings-state.ts
/**
* Pending timer for the bearer-token retirement confirm, else null.
*
* A second click inside the window is the confirm; letting it lapse cancels —
* so the handle IS the "are we confirming?" state, not a detail of it.
*/
var bearerConfirmTimer = ref(null);
/** Which speech backend the operator picked in the STT installer: 'local' | … */
var sttChosenBackend = ref("local");
//#endregion
//#region src/features/modals-state.ts
/** Is the image lightbox open? Gates the global key handlers it installs. */
var lightboxOpen = ref(false);
//#endregion
//#region src/features/attach-picker-state.ts
var attachRows = ref([]);
var attachEmptyText = ref("");
/** The open picker's config, or null when closed. */
var attachPickerCfg = ref(null);
/** Files staged in the composer, awaiting send. */
var pendingFiles = ref([]);
//#endregion
//#region src/features/views-state.ts
/** Is the Admin view open? */
var adminActive = ref(false);
/** Is the help overlay open? */
var helpActive = ref(false);
/** Is the Manage view open? */
var manageActive = ref(false);
/** Active Manage tab — the header's shared sort icon acts on whichever it is. */
var manageTab = ref("agents");
/** Last topology payload, or null before the first fetch. */
var topoData = ref(null);
/**
* "roomId|agentId" for currently-wired pairs.
*
* A ref, not a bare Set: refreshMatrix REPLACES it wholesale from the topology
* payload, and an imported const cannot be reassigned. It is also mutated in
* place when a single cell toggles — both patterns are real, which is why my
* first pass called it in-place-only and the compiler disagreed.
*/
var matrixWired = ref(/* @__PURE__ */ new Set());
/** The open full views, innermost last: [{ name, teardown }]. Pushed and popped,
*  never replaced, so closing one runs exactly its own teardown. */
var viewStack = [];
//#endregion
//#region src/features/model-list-state.ts
var modelRows = ref([]);
/** The model roster, verbatim from /api/models. */
var allModels = ref([]);
/** Last endpoint probe: { kind, endpoint, models, … }. */
var lastProbeResult = ref(null);
/** The model whose detail pane is open, or null. */
var selectedModelId = ref(null);
/** A–Z toggle, restored from the session — the read was the `let`'s
*  initialiser, and dropping it makes the preference per-reload. */
var modelSortAz = ref(sessionStorage.getItem("webchat:modelSortAz") === "1");
//#endregion
//#region src/features/agent-detail-state.ts
/** Rooms this agent is assigned to, as /api/agents/:id/rooms returns them. */
var wiredRooms = ref([]);
/** Whether the caller may unassign rooms — hides the per-row remove button. */
var canManageRooms = ref(false);
/** One row of /api/agents/:id/sessions. */
var sessions = ref([]);
/**
* The session list is asynchronous and has three non-row states — loading, a
* fetch failure, and genuinely empty. The imperative version distinguished them
* by writing three different innerHTML strings; as a ref it is one field the
* template switches on, which is also what stops a stale "Loading…" row from
* surviving a failed fetch.
*/
var sessionsPhase = ref("loading");
/** Message for the error phase — already plain text, escaped by the binding. */
var sessionsError = ref("");
/** Snapshot of the detail form when it opened — Save stays disabled until an
*  edit actually diverges from this. */
var agentDetailBaseline = ref(null);
/** Rooms the open agent is wired to. */
var agentDetailRooms = ref([]);
/** Agents wired to the open ROOM — the room detail's mirror of the above. */
var roomDetailWiredAgents = ref([]);
/** Include archived agents in the list? Pickers and the map never do. */
var showArchivedAgents = ref(false);
/** How many archived agents exist — drives the toggle's count + visibility. */
var archivedAgentsCount = ref(0);
/** setInterval handle ticking the thinking bubbles' elapsed labels, else null.
*  An interval here, unlike the installers' re-arming timeouts. */
var turnElapsedTimer = ref(null);
//#endregion
//#region src/features/routing-state.ts
/**
* The classifier model id, or null before the routing probe has answered.
*
* Infrastructure, never selectable: the models list and the Ollama host cards
* both section it under "System" rather than offering it as a choice, and both
* need it before they render or it flashes as selectable first.
*/
var routingClassifierModel = ref(null);
/** Is the routing skill installed and reachable? Gates the whole panel. */
var routingAvailable = ref(false);
/** Which router the server returned config for — it decides, not the client. */
var routingCurrentRouter = ref(null);
/** The editable config: {routes:[…], live:{…}, default_route}. Null until loaded. */
var routingDraft = ref(null);
/** {endpoint, models} for the Router models section. */
var routingRouterInfo = ref(null);
/** Open route's index, or -1 for "new route being drafted" — see openRouteDetail. */
var selectedRouteIdx = ref(null);
//#endregion
//#region src/features/installer-state.ts
var codexInstallActive = ref(false);
var opencodeInstallActive = ref(false);
var routingInstallActive = ref(false);
var sttInstallActive = ref(false);
var ttsInstallActive = ref(false);
var tailscaleInstallActive = ref(false);
var cloudflaredInstallActive = ref(false);
/**
* Pending setTimeout handles while a poll is in flight, else null.
*
* setTimeout, not setInterval: both poll by re-arming after each response, so a
* slow server cannot stack overlapping requests the way a fixed interval would.
* Typing them as interval handles compiled but was wrong about the mechanism.
*/
var ollamaPullPoller = ref(null);
var opencodeGatePoll = ref(null);
/**
* The gate as the SERVER reports it ('running'), rather than as this tab
* remembers it — which is what makes it survive a page reload.
*/
var opencodeGateFromServer = ref(false);
//#endregion
//#region src/features/mcp-list-state.ts
var mcpServers = ref([]);
var selectedMcpId = ref(null);
/** MCP servers attached to the currently open agent. */
var agentMcpServers = ref([]);
/** Every registered MCP server. */
var allMcpServers = ref([]);
/** Last successful probe result, and the bearer token that made it work —
*  carried into the add body so the registered server keeps working. */
var lastMcpProbe = ref(null);
var lastMcpProbeToken = ref("");
/** Re-entry guard while an add is in flight. */
var mcpAddInProgress = ref(false);
/** Agent the add flow should attach to on success, or null for unattached. */
var mcpAgentForAdd = ref(null);
//#endregion
//#region src/features/room-list-state.ts
/** A–Z toggle: alphabetical by the displayed `#id` when on, activity when off. */
/** Restored from the session — the sessionStorage read was the `let`'s
*  initialiser in legacy.js, and dropping it turns a remembered preference
*  into a per-reload default. */
var roomSortAz = ref(sessionStorage.getItem("webchat:roomSortAz") === "1");
/** Per-user "hide" reveal toggle. */
/** Restored from the session — the sessionStorage read was the `let`'s
*  initialiser in legacy.js, and dropping it turns a remembered preference
*  into a per-reload default. */
var showHidden = ref(sessionStorage.getItem("webchat:showHidden") === "1");
/** Archived section reveal toggle. */
/** Restored from the session — the sessionStorage read was the `let`'s
*  initialiser in legacy.js, and dropping it turns a remembered preference
*  into a per-reload default. */
var showArchived = ref(sessionStorage.getItem("webchat:showArchived") === "1");
/**
* The pinned room currently being dragged, or null.
*
* Drag has two modes and they must not fire together: an UNPINNED row dragged
* onto the list pins it (list-level drop, gated on .room-list-dragging), a
* PINNED row dragged over another pinned row reorders (row-level, gated on
* .room-list-reordering plus this id).
*/
var draggedPinId = ref(null);
/**
* Which row's kebab menu is open, or null. At most one across the list.
*
* This is why renderRooms had a retry timer: the menu was a DOM node inside the
* list, so any background re-render tore it down mid-click and the code
* deferred the update by 400ms instead. As state the menu survives a re-render,
* and the retry is gone with it.
*/
var openMenuRoomId = ref(null);
/** Which thread's kebab menu is open, or null. */
var openThreadMenuId = ref(null);
/** Row showing a drop-marker during a pinned reorder: id → 'before' | 'after'. */
var dropMarker = ref({});
/**
* Threads with a delete countdown armed, keyed by thread_id.
*
* This replaces armUndo()'s DOM swap. armUndo was handed the ROW — not an
* actions strip — captured its childNodes, replaced them with the timer and
* re-appended them on Undo. ThreadRows renders those children, so that was an
* imperative writer reinserting vnode-managed nodes behind Vue's back: the last
* two-writers case in the codebase and the reason armUndo could not be deleted
* with the rest of legacy.js.
*
* `width` is measured BEFORE the swap and pinned on the row, exactly as armUndo
* did — measuring after would read the timer's own width and defeat the point.
*/
var threadUndo = ref({});
/** The room whose detail pane is open, or null. */
/**
* Live room-name filter, driven by the sidebar search box as you type.
*
* Deliberately NOT debounced and never sent anywhere: matching a name the
* client already holds costs nothing, so the list narrows on the keystroke
* while the MESSAGE search under it still waits out its 250ms. One box, two
* speeds — the fast half should not be held back by the slow one.
*/
var roomFilter = ref("");
var selectedRoomId = ref(null);
/** Tool calls seen this turn — the learning nudge fires above a threshold. */
var learnTurnToolCount = ref(0);
/** room id → auto-learn setting. Mutated in place as rooms answer, never
*  replaced, so it stays a plain Map. */
var roomAutoLearn = /* @__PURE__ */ new Map();
//#endregion
//#region src/features/agent-list-state.ts
/** Restored from the session — the sessionStorage read was the `let`'s
*  initialiser in legacy.js, and dropping it turns a remembered preference
*  into a per-reload default. */
/** Live agent-name filter, driven by the Manage toolbar's filter box. */
var agentFilter = ref("");
var agentSortAz = ref(sessionStorage.getItem("webchat:agentSortAz") === "1");
var selectedAgentId = ref(null);
//#endregion
//#region src/features/members-list-state.ts
var members = ref([]);
var membersFilter = ref("");
/**
* A–Z toggle for the members roster, restored from the session.
*
* The sessionStorage read is the POINT, not decoration: it was the `let`'s
* initialiser in legacy.js, and dropping it silently turned a remembered
* preference into a per-reload default. The boot-order guard caught it as a
* missing storage read at event 39.
*/
var usersSortAz = ref(sessionStorage.getItem("webchat:usersSortAz") === "1");
//#endregion
//#region src/core/dom.ts
/** querySelector, the shorthand the whole UI is written in. */
var $ = (sel) => document.querySelector(sel);
/** Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
* string (safe — no user data); styling/color come from the .icon CSS class. */
function lucide(name, cls = "") {
	return `<svg class="icon${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
/** HTML-escape for the few places that still build markup as a string.
* `'` is escaped too: every current attribute interpolation is double-quoted,
* but nothing enforces that, and a future single-quoted attribute built with
* esc() would otherwise be a breakout. Cheap insurance, not a fix for a bug. */
function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function cssEscape(s) {
	if (window.CSS && CSS.escape) return CSS.escape(String(s));
	return String(s).replace(/["\\\]]/g, "\\$&");
}
//#endregion
//#region src/core/state.ts
/**
* shallowReactive, NOT reactive — and not a plain object any more either.
*
* Vue islands re-render when what they read changes, so this object has to be a
* reactivity root. It is a one-line change only because of the phase-1h
* decision above: every one of the ~138 call sites already writes `state.x = 1`
* and `state.x++` against this single binding, so wrapping the literal makes all
* of them reactive without touching any of them. Accessor pairs would have
* needed all 138 rewritten.
*
* Shallow, for three reasons — none of them correctness. Deep `reactive()` is
* SAFE here: it refuses to proxy anything outside Object/Array/Map/Set, so the
* `WebSocket` and the `HTMLElement` values in pendingMessages come back raw
* either way, and every identity comparison in this codebase is against a
* string (`state.currentRoom`, `state.myIdentity`) which proxying cannot touch.
* The reasons are:
*
*  1. Cost. lastRoomsList, allAgents and threadCache are iterated constantly by
*     the room list and transcript. Deep reactivity allocates a proxy per
*     element per read; shallow allocates none.
*  2. pendingMessages maps ids to DOM nodes — imperative render bookkeeping,
*     not view state. Deep reactivity would track every set() and wake effects
*     for something no island ever reads.
*  3. It makes an existing contract explicit for the ARRAYS. They are assigned
*     wholesale (`state.lastRoomsList = msg.rooms`), never pushed into.
*
* The consequence to know: `state.rooms.push(r)` will NOT trigger a re-render.
* `state.rooms = [...state.rooms, r]` will. That is already how this code is
* written; island code has to keep it that way.
*
* Reason 3 was stated here as holding for EVERY collection, and that was wrong.
* The five Set/Map fields below are mutated in place at twenty-five call sites
* and never assigned wholesale — .add(), .delete(), .set(), .clear(). Under a
* plain shallowReactive parent those mutations notify nothing, so an island
* reading them re-rendered only when something ELSE happened to change.
*
* That shipped as a visible bug: clicking a room's thread-tree chevron recorded
* the expansion and drew nothing, because renderRooms syncs three unrelated
* refs and none of them changed. The tree appeared on the next unrelated
* render — a rooms broadcast, a sort toggle — which is why it looked
* intermittent rather than broken.
*
* So the five are individually shallowReactive. That instruments the COLLECTION
* (add/delete/set/clear notify, has/get track) while still returning raw values
* on read — reason 1's cost argument survives intact, which a deep reactive()
* on threadCache would not have allowed.
*/
var state = shallowReactive({
	learningMasterEnabled: true,
	serverUsesTailscale: (() => {
		try {
			return localStorage.getItem("webchat-server-tailscale") === "1";
		} catch {
			return false;
		}
	})(),
	lastProbeAt: 0,
	lastDiagnosis: null,
	settings: null,
	ws: null,
	currentRoom: null,
	myIdentity: "",
	myHandle: "",
	pendingMessages: /* @__PURE__ */ new Map(),
	typingUsers: /* @__PURE__ */ new Map(),
	unreadRooms: shallowReactive(/* @__PURE__ */ new Set()),
	mentionedRooms: shallowReactive(/* @__PURE__ */ new Set()),
	agentName: "",
	lastSeenMessageId: sessionStorage.getItem("lastSeenMessageId") || null,
	reconnectDelay: 1e3,
	roomActivity: /* @__PURE__ */ new Map(),
	lastRoomsList: [],
	currentThread: "main",
	threadCreating: false,
	threadAddRoom: null,
	threadRenaming: null,
	threadUnread: shallowReactive(/* @__PURE__ */ new Set()),
	expandedRooms: shallowReactive(/* @__PURE__ */ new Set()),
	threadCache: shallowReactive(/* @__PURE__ */ new Map()),
	pendingJumpMessageId: null,
	pendingSendAfterJoin: null,
	oldestMessageId: null,
	loadingOlder: false,
	noMoreOlder: false,
	missedMsgCount: 0,
	forceScrollCount: 0,
	userScrolledAway: false,
	isOwnerView: false,
	marketplaceEnabled: false,
	allAgents: []
});
/**
* Is the transcript being force-followed right now?
*
* forceScrollCount is set on send so the agent's reply scrolls into view, and
* userScrolledAway cancels it the moment the reader takes over. Both live here,
* so the derivation does too — it reached the thinking bubble through an
* isForcedScroll() entry on the Thinking bridge, which existed only because the
* expression sat in legacy.js.
*/
function isForcedScroll() {
	return state.forceScrollCount > 0 && !state.userScrolledAway;
}
/**
* Set by probeIsOwner — true for any admin, where isOwnerView is the stricter
* owner-only flag. Both gate write controls, at different levels, which is why
* they are two values and not one.
*/
var isAdminView = ref(false);
//#endregion
//#region src/core/toast.ts
function showToast(message, { kind = "info", timeout } = {}) {
	const container = $("#toasts");
	if (!container) return null;
	const toast = document.createElement("div");
	toast.className = `toast toast-${kind}`;
	toast.setAttribute("role", kind === "error" ? "alert" : "status");
	toast.textContent = message;
	const remove = () => {
		if (!toast.parentNode) return;
		toast.classList.add("toast-out");
		setTimeout(() => toast.remove(), 180);
	};
	toast.addEventListener("click", remove);
	container.appendChild(toast);
	setTimeout(remove, timeout ?? (kind === "error" ? 7e3 : 4e3));
	return toast;
}
/** Error → toast, one shape everywhere (kind:'error' can't be forgotten). */
function toastError(err, fallback) {
	const message = err?.message;
	showToast(message || fallback || "Something went wrong", { kind: "error" });
}
//#endregion
//#region src/core/api.ts
var authToken = sessionStorage.getItem("nanoclaw-token") || "";
function getAuthToken() {
	return authToken;
}
function setAuthToken(token) {
	authToken = token;
}
function getWsUrl() {
	return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}
function getWsProtocols() {
	return authToken ? [`bearer.${authToken}`] : [];
}
function authFetch(url, opts = {}) {
	const headers = { ...opts.headers };
	if (authToken && !headers["Authorization"] && !headers["authorization"]) headers["Authorization"] = `Bearer ${authToken}`;
	headers["X-Webchat-CSRF"] = "1";
	return fetch(url, {
		...opts,
		headers
	});
}
/** authFetch + JSON ceremony in one call. Sends a JSON body when `body` is
* given, parses the JSON response (tolerating empty/non-JSON), and throws
* Error(body.error || statusText) on !ok. Options: { method, body, headers }. */
async function apiJson(url, { method = "GET", body, headers } = {}) {
	const opts = {
		method,
		headers: { ...headers }
	};
	if (body !== void 0) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await authFetch(url, opts);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data.error || res.statusText || `HTTP ${res.status}`);
		err.status = res.status;
		err.body = data;
		throw err;
	}
	return data;
}
//#endregion
//#region src/features/approvals-state.ts
/** Pending approvals, as the panel list renders them. */
var approvalRows = ref([]);
/**
* Question ids whose respond call is in flight, and the inline error left by
* one that failed.
*
* These were DOM writes: respondToApproval took the card element, disabled its
* buttons through querySelectorAll and appended a .approval-error div to it.
* The panel's cards are rendered by ApprovalCard, so those writes were landing
* on Vue-owned nodes — the two-writers shape, reached from the imperative side.
*/
var approvalBusy = ref(/* @__PURE__ */ new Set());
var approvalErrors = ref({});
//#endregion
//#region src/features/ApprovalCard.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$69 = ["data-question-id"];
var _hoisted_2$60 = { class: "approval-title" };
var _hoisted_3$55 = {
	key: 0,
	class: "approval-payload"
};
var _hoisted_4$45 = { class: "approval-actions" };
var _hoisted_5$34 = ["disabled", "onClick"];
var _hoisted_6$27 = {
	key: 1,
	class: "approval-error"
};
//#endregion
//#region src/features/ApprovalCard.vue
var ApprovalCard_default = /* @__PURE__ */ defineComponent({
	__name: "ApprovalCard",
	props: {
		approval: {},
		onRespond: { type: Function }
	},
	setup(__props) {
		/**
		* One approval card — the <li> form, shared by the panel list and the
		* in-transcript card.
		*
		* NOT the toast form. renderApprovalCard() still builds that imperatively: a
		* toast is a transient element appended by the toast layer, it drops the
		* payload block, and it has no container to claim. Keeping one component for
		* two of the three callers is the honest split; forcing the third through it
		* would mean a `toast` prop that changes the element's tag.
		*
		* :class, NOT a conditional v-bind. This is the inverse of the usual case: the
		* imperative version assigned btn.className unconditionally, so an option that
		* is neither approve nor reject emits class="" — and Vue's :class emits the
		* empty attribute too. Omitting it would be the difference here.
		*
		* The busy and error state comes from module refs, not props. respondToApproval
		* used to reach into this card's DOM — disabling its buttons through
		* querySelectorAll and appending a .approval-error div to it — which is an
		* imperative writer on Vue-owned nodes. Keyed by questionId because one
		* approval can be on screen twice (the panel and the transcript).
		*
		* `disabled` reflects to an attribute, so binding it reproduces the imperative
		* assignment exactly (measured in #244) — the diff shows disabled="" on both
		* sides while a response is in flight.
		*
		* The error's v-if leaves an anchor comment when there is no error, the same
		* accepted difference as #246. It vanishes in the state that matters: with an
		* error present both sides render the div and the markup is byte-identical,
		* which is also the proof that appending it imperatively and rendering it
		* declaratively produce the same DOM.
		*
		* The default option pair is Approve/Reject. It is a fallback, not a default
		* argument — a request that supplies options replaces both, and one that
		* supplies an empty array still gets the pair.
		*/
		const props = __props;
		const FALLBACK = [{
			label: "Approve",
			value: "approve"
		}, {
			label: "Reject",
			value: "reject"
		}];
		const options = () => Array.isArray(props.approval.options) && props.approval.options.length ? props.approval.options : FALLBACK;
		const payloadText = (p) => typeof p === "string" ? p : JSON.stringify(p, null, 2);
		const btnClass = (v) => v === "approve" ? "approve" : v === "reject" ? "reject" : "";
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("li", {
				class: "approval-card",
				"data-question-id": __props.approval.questionId
			}, [
				createElementVNode("div", _hoisted_2$60, toDisplayString(__props.approval.title || __props.approval.action || "Approval requested"), 1),
				__props.approval.payload ? (openBlock(), createElementBlock("pre", _hoisted_3$55, toDisplayString(payloadText(__props.approval.payload)), 1)) : createCommentVNode("", true),
				createElementVNode("div", _hoisted_4$45, [(openBlock(true), createElementBlock(Fragment, null, renderList(options(), (o, i) => {
					return openBlock(), createElementBlock("button", {
						key: i,
						class: normalizeClass(btnClass(o.value)),
						disabled: unref(approvalBusy).has(__props.approval.questionId) || void 0,
						onClick: ($event) => props.onRespond(__props.approval.questionId, o.value)
					}, toDisplayString(o.label || o.value), 11, _hoisted_5$34);
				}), 128))]),
				unref(approvalErrors)[__props.approval.questionId] ? (openBlock(), createElementBlock("div", _hoisted_6$27, toDisplayString(unref(approvalErrors)[__props.approval.questionId]), 1)) : createCommentVNode("", true)
			], 8, _hoisted_1$69);
		};
	}
});
//#endregion
//#region src/features/ApprovalsList.vue
var ApprovalsList_default = /* @__PURE__ */ defineComponent({
	__name: "ApprovalsList",
	props: { onRespond: { type: Function } },
	setup(__props) {
		/**
		* The pending-approvals panel list — forty-fifth island.
		*
		* Mounted into <ul id="approval-list">, exclusively owned by this module. The
		* banner count is set outside it and stays imperative.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(approvalRows), (a) => {
				return openBlock(), createBlock(ApprovalCard_default, {
					key: a.questionId,
					approval: a,
					"on-respond": props.onRespond
				}, null, 8, ["approval", "on-respond"]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/ApprovalToast.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$68 = { class: "approval-title" };
var _hoisted_2$59 = { class: "approval-actions" };
var _hoisted_3$54 = ["disabled", "onClick"];
//#endregion
//#region src/features/ApprovalToast.vue
var ApprovalToast_default = /* @__PURE__ */ defineComponent({
	__name: "ApprovalToast",
	props: {
		approval: {},
		onRespond: { type: Function }
	},
	setup(__props) {
		/**
		* The transient approval toast.
		*
		* Deliberately NOT ApprovalCard: a toast is a <div class="approval-toast">, it
		* drops the payload block, and the toast layer owns where it goes. The two
		* shared a builder before and the difference was a `toast` flag that changed
		* the element's tag — one component for both would need the same flag back.
		*
		* Mounted into the toast element itself, one app per toast, so the host carries
		* the class and data-question-id the toast layer and respondToApproval select
		* on, and the component supplies its children.
		*
		* Busy state is shared with the card via approvalBusy, keyed by questionId —
		* the same approval can be on screen as a toast AND in the panel, and clicking
		* either should disable both.
		*/
		const props = __props;
		const FALLBACK = [{
			label: "Approve",
			value: "approve"
		}, {
			label: "Reject",
			value: "reject"
		}];
		const options = () => Array.isArray(props.approval.options) && props.approval.options.length ? props.approval.options : FALLBACK;
		const btnClass = (v) => v === "approve" ? "approve" : v === "reject" ? "reject" : "";
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [createElementVNode("div", _hoisted_1$68, toDisplayString(__props.approval.title || __props.approval.action || "Approval requested"), 1), createElementVNode("div", _hoisted_2$59, [(openBlock(true), createElementBlock(Fragment, null, renderList(options(), (o, i) => {
				return openBlock(), createElementBlock("button", {
					key: i,
					class: normalizeClass(btnClass(o.value)),
					disabled: unref(approvalBusy).has(__props.approval.questionId) || void 0,
					onClick: ($event) => props.onRespond(__props.approval.questionId, o.value)
				}, toDisplayString(o.label || o.value), 11, _hoisted_3$54);
			}), 128))])], 64);
		};
	}
});
//#endregion
//#region src/features/approvals.ts
var pendingApprovals = [];
function setApprovalsBanner(count) {
	const banner = $("#approvals-banner");
	if (!banner) return;
	const countEl = $("#approvals-count");
	const textEl = banner.querySelector(".approvals-banner-text");
	if (!countEl || !textEl) return;
	if (count <= 0) {
		banner.hidden = true;
		banner.classList.remove("expanded");
		const list = $("#approval-list");
		if (list) list.hidden = true;
		$("#approvals-banner-toggle")?.setAttribute("aria-expanded", "false");
		return;
	}
	banner.hidden = false;
	countEl.textContent = String(count);
	const noun = count === 1 ? "approval" : "approvals";
	textEl.innerHTML = "";
	textEl.appendChild(countEl);
	textEl.appendChild(document.createTextNode(` ${noun} pending`));
}
var approvalsApp = null;
function mountApprovalsList() {
	if (approvalsApp) return;
	const host = $("#approval-list");
	if (!host) return;
	approvalsApp = createApp(ApprovalsList_default, { onRespond: (questionId, value) => respondToApproval(questionId, value, null) });
	approvalsApp.mount(host);
}
function renderApprovalsList() {
	if ($("#approval-list")) {
		approvalRows.value = [...pendingApprovals];
		mountApprovalsList();
	}
	setApprovalsBanner(pendingApprovals.length);
}
async function fetchApprovals() {
	try {
		const r = await authFetch("/api/approvals/pending");
		if (!r.ok) return;
		pendingApprovals = await r.json();
		renderApprovalsList();
	} catch (err) {
		console.error("fetchApprovals failed:", err);
	}
}
function showApprovalToast(a) {
	const container = $("#approval-toasts");
	if (!container) return;
	const toast = document.createElement("div");
	toast.className = "approval-toast";
	toast.dataset.questionId = a.questionId;
	const app = createApp(ApprovalToast_default, {
		approval: a,
		onRespond: (questionId, value) => void respondToApproval(questionId, value, toast)
	});
	app.mount(toast);
	container.appendChild(toast);
	setTimeout(() => {
		if (toast.parentNode) {
			app.unmount();
			toast.remove();
		}
	}, 3e4);
}
function handleApprovalResolvedEvent(msg) {
	const approvalId = msg.approvalId;
	if (!approvalId) return;
	pendingApprovals = pendingApprovals.filter((a) => a.questionId !== approvalId);
	renderApprovalsList();
	document.querySelectorAll(`.approval-toast[data-question-id="${approvalId}"]`).forEach((el) => el.remove());
	document.querySelectorAll(`.approval-msg[data-question-id="${approvalId}"]`).forEach((el) => {
		const who = msg.resolvedBy ? " by " + (String(msg.resolvedBy).split(":").pop() ?? "").split("@")[0] : "";
		el.innerHTML = "";
		const note = document.createElement("div");
		note.className = "approval-inroom-note resolved";
		note.textContent = `🔒 Approval — resolved${who}`;
		el.appendChild(note);
	});
}
function handleApprovalEvent(msg) {
	showApprovalToast(msg);
	fetchApprovals();
	if (state.settings?.notifications && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") try {
		new Notification(msg.title || "Approval requested", { body: msg.question || "" });
	} catch {}
}
async function respondToApproval(questionId, value, cardEl) {
	const setBusy = (on) => {
		const next = new Set(approvalBusy.value);
		if (on) next.add(questionId);
		else next.delete(questionId);
		approvalBusy.value = next;
	};
	const setError = (msg) => {
		const next = { ...approvalErrors.value };
		if (msg) next[questionId] = msg;
		else delete next[questionId];
		approvalErrors.value = next;
	};
	setBusy(true);
	setError(null);
	const toastEl = cardEl ?? document.querySelector(`.approval-toast[data-question-id="${questionId}"]`);
	toastEl?.querySelectorAll("button").forEach((b) => b.disabled = true);
	try {
		const r = await authFetch(`/api/approvals/${encodeURIComponent(questionId)}/respond`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ value })
		});
		if (!r.ok) {
			const body = await r.json().catch(() => ({}));
			console.error("Approval respond failed:", r.status, body);
			setBusy(false);
			setError(`Couldn't respond (${r.status}): ${body.error || r.statusText}`);
			toastEl?.querySelectorAll("button").forEach((b) => b.disabled = false);
			return;
		}
		pendingApprovals = pendingApprovals.filter((a) => a.questionId !== questionId);
		setBusy(false);
		renderApprovalsList();
		document.querySelectorAll(`.approval-toast[data-question-id="${questionId}"]`).forEach((el) => el.remove());
	} catch (err) {
		console.error("Approval respond errored:", err);
		setBusy(false);
		toastEl?.querySelectorAll("button").forEach((b) => b.disabled = false);
	}
}
var approvalsBannerToggle = $("#approvals-banner-toggle");
function wireApprovalsPanel() {
	if (approvalsBannerToggle) approvalsBannerToggle.addEventListener("click", () => {
		const banner = $("#approvals-banner");
		const list = $("#approval-list");
		if (!banner || !list) return;
		const expanded = banner.classList.toggle("expanded");
		list.hidden = !expanded;
		approvalsBannerToggle.setAttribute("aria-expanded", String(expanded));
	});
}
//#endregion
//#region src/features/transcript-state.ts
/** Monotonic row key. Server ids are absent on the optimistic echo and on
*  system lines, so identity cannot come from the payload. */
var seq = 0;
var nextKey = () => ++seq;
/** The transcript, oldest first. Prepends (pagination) unshift. */
var messages = ref([]);
/** Replaces the whole list — room switch, history load, clear. */
function setMessages(rows) {
	messages.value = rows;
}
/**
* Put an EXISTING row back in the list and return the reactive proxy for it.
*
* Only the history handler needs this, and only for optimistic rows: a message
* sent between the join and the history reply is not in that payload, because
* the server queried before it existed. Re-appending the original object (not a
* copy) is what keeps the echo working — the echo upgrades the row it was
* handed, so the caller must also repoint at the returned proxy; mutating the
* raw object notifies nothing.
*/
function readdRow(row) {
	messages.value = [...messages.value, row];
	return messages.value[messages.value.length - 1];
}
/** Empty-state line shown instead of the list. Two callers set it. */
var transcriptEmpty = ref(null);
/** Live thinking bubbles, keyed by agent name. Rendered AFTER the message list,
*  which is what made messages "insert before the thinking bubble" fall out for
*  free instead of needing an anchor. */
var thinkingTurns = ref([]);
var turnFor = (name) => thinkingTurns.value.find((t) => t.name === name);
//#endregion
//#region src/features/ThinkingBubble.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$67 = ["data-agent"];
var _hoisted_2$58 = { class: "sender" };
var _hoisted_3$53 = { class: "thinking-verb" };
var _hoisted_4$44 = { class: "thinking-elapsed" };
var _hoisted_5$33 = { class: "bubble" };
var _hoisted_6$26 = ["hidden"];
var _hoisted_7$18 = ["hidden"];
var _hoisted_8$13 = ["hidden"];
var _hoisted_9$8 = {
	ref: "trace",
	class: "thinking-fulltrace"
};
var STOP = "Stop";
var STOP_TITLE = "Stop the agent";
var NO_TRACE = "No reasoning captured for this turn yet.";
//#endregion
//#region src/features/ThinkingBubble.vue
var ThinkingBubble_default = /* @__PURE__ */ defineComponent({
	__name: "ThinkingBubble",
	props: {
		turn: {},
		onStop: { type: Function },
		onToggle: { type: Function }
	},
	setup(__props) {
		/**
		* One agent's live thinking bubble.
		*
		* Reproduces ensureThinkingBubble's markup exactly, including the four content
		* divs that were written as one innerHTML string and then addressed
		* individually by four different functions — the verb and target by
		* updateThinkingBubble, the milestone by setThinkingMilestone, the feed by
		* pushReasoning, the fulltrace by renderFullTrace. Those four were the reason
		* this could not be converted on its own: each held a querySelector into a
		* bubble that a component would own.
		*
		* The feed is a BOUNDED TAIL with per-line fade state, not a slice of
		* reasoningLog. pushReasoning kept both — the full log for the expanded trace
		* and the reply's disclosure, and a trimmed DOM buffer for the fading window —
		* and collapsing them would change what the expanded view shows.
		*
		* data-status-live is still rendered even though nothing reads it from the DOM
		* any more — the typing heartbeat reads turn.statusLive now. It stays because
		* the attribute was there before and dropping it would be a markup change
		* smuggled in under a conversion.
		*
		* Feed scroll-follow stays imperative on purpose: it is a scrollTop write on an
		* element Vue owns, which is not a second WRITER (it renders nothing), and
		* there is no declarative way to say "keep the newest line in view".
		*/
		const props = __props;
		const feedEl = useTemplateRef("feed");
		const traceEl = useTemplateRef("trace");
		/** Follow the newest line inside the feed's own scroll viewport, and keep the
		*  expanded trace pinned to the bottom — both were scrollTop writes after the
		*  append that produced them. */
		watch(() => props.turn.feed.length, () => void nextTick(() => {
			if (feedEl.value) feedEl.value.scrollTop = feedEl.value.scrollHeight;
		}));
		watch([() => props.turn.reasoningLog.length, () => props.turn.expanded], () => void nextTick(() => {
			if (traceEl.value) traceEl.value.scrollTop = traceEl.value.scrollHeight;
		}));
		/** renderFullTrace only ran on expand, so a collapsed bubble's trace div stayed
		*  EMPTY — not merely hidden. Both derivations reproduce that. */
		const traceRows = computed(() => props.turn.expanded ? props.turn.reasoningLog : []);
		const traceEmpty = computed(() => props.turn.expanded && !props.turn.reasoningLog.length ? NO_TRACE : "");
		function onClick(e) {
			if (e.target?.closest("a, button")) return;
			props.onToggle(props.turn.name);
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("div", mergeProps({
				class: __props.turn.expanded ? "msg agent thinking-bubble expanded" : "msg agent thinking-bubble",
				"data-agent": __props.turn.name
			}, __props.turn.statusLive ? { "data-status-live": "1" } : {}, { onClick }), [createElementVNode("div", _hoisted_2$58, [
				_cache[2] || (_cache[2] = createElementVNode("svg", {
					class: "icon",
					"aria-hidden": "true"
				}, [createElementVNode("use", { href: "#i-bot" })], -1)),
				createTextVNode(toDisplayString(` ${__props.turn.name} — `), 1),
				createElementVNode("span", _hoisted_3$53, toDisplayString(__props.turn.verb), 1),
				createElementVNode("span", _hoisted_4$44, toDisplayString(__props.turn.elapsed), 1),
				_cache[3] || (_cache[3] = createElementVNode("span", { class: "thinking-chevron" }, [createElementVNode("svg", {
					class: "icon",
					"aria-hidden": "true"
				}, [createElementVNode("use", { href: "#i-chevron-right" })])], -1)),
				createElementVNode("button", {
					type: "button",
					class: "thinking-stop",
					title: STOP_TITLE,
					"aria-label": STOP_TITLE,
					onClick: _cache[0] || (_cache[0] = withModifiers(($event) => props.onStop(__props.turn.name), ["stop"]))
				}, [_cache[1] || (_cache[1] = createElementVNode("span", {
					class: "stop-square",
					"aria-hidden": "true"
				}, null, -1)), createTextVNode(toDisplayString(STOP))])
			]), createElementVNode("div", _hoisted_5$33, [
				createElementVNode("div", {
					class: "thinking-milestone",
					hidden: !__props.turn.milestone
				}, toDisplayString(__props.turn.milestone), 9, _hoisted_6$26),
				createElementVNode("div", {
					class: "thinking-target",
					hidden: !__props.turn.detail
				}, toDisplayString(__props.turn.detail), 9, _hoisted_7$18),
				createElementVNode("div", {
					ref: "feed",
					class: "thinking-feed",
					hidden: !__props.turn.feed.length
				}, [(openBlock(true), createElementBlock(Fragment, null, renderList(__props.turn.feed, (l) => {
					return openBlock(), createElementBlock("div", {
						key: l.key,
						class: normalizeClass(l.fading ? "thinking-feed-line fading" : "thinking-feed-line")
					}, toDisplayString(l.text), 3);
				}), 128))], 8, _hoisted_8$13),
				createElementVNode("div", _hoisted_9$8, [createTextVNode(toDisplayString(traceEmpty.value), 1), (openBlock(true), createElementBlock(Fragment, null, renderList(traceRows.value, (l, i) => {
					return openBlock(), createElementBlock("div", {
						key: i,
						class: "thinking-fulltrace-line"
					}, toDisplayString(l), 1);
				}), 128))], 512),
				_cache[4] || (_cache[4] = createElementVNode("span", { class: "dots" }, [
					createElementVNode("span"),
					createElementVNode("span"),
					createElementVNode("span")
				], -1))
			])], 16, _hoisted_1$67);
		};
	}
});
//#endregion
//#region src/features/voice.ts
var ttsServerEnabled = false;
var ttsReadAloudEnabled = false;
var ttsCurrentAudio = null;
/**
* Which message is playing, and how far along.
*
* This was the button ELEMENT (ttsCurrentBtn) — identity comparisons all the way
* through speak(), so a later click could supersede an in-flight fetch. The row
* key does the same job while the button is rendered by TtsButton rather than
* built by hand, which it has to be now that messages are Vue-owned.
*/
var ttsActiveKey = ref(null);
var ttsPhase = ref(null);
async function loadTtsConfig() {
	try {
		const r = await authFetch("/api/tts/config");
		if (r.ok) {
			const cfg = await r.json();
			ttsServerEnabled = cfg.enabled === true;
			ttsReadAloudEnabled = cfg.readAloud === true;
		}
	} catch {
		ttsServerEnabled = false;
	}
}
function ttsAvailable() {
	return ttsServerEnabled || typeof window !== "undefined" && "speechSynthesis" in window;
}
function ttsPlainText(md) {
	return String(md || "").replace(/```[\s\S]*?```/g, " (code block) ").replace(/`([^`]+)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^[>#\s]*/gm, "").replace(/[*_~]/g, "").replace(/\n{2,}/g, ". ").replace(/\s+/g, " ").trim();
}
function stopTts() {
	if (ttsCurrentAudio) {
		ttsCurrentAudio.pause();
		if (ttsCurrentAudio.src) URL.revokeObjectURL(ttsCurrentAudio.src);
		ttsCurrentAudio = null;
	}
	if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
	ttsActiveKey.value = null;
	ttsPhase.value = null;
}
/** Is the read-aloud affordance offered at all? Workspace-gated by the OWNER in
*  Settings → Features; per-device switches confused shared rooms. */
function ttsOffered() {
	return !!ttsReadAloudEnabled && ttsAvailable();
}
/** One message's button: the playing one stops, any other supersedes. getText is
*  called at click time so the freshest bubble content is spoken. */
function toggleTts(key, getText) {
	if (ttsActiveKey.value === key) {
		stopTts();
		return;
	}
	stopTts();
	const text = (getText() || "").trim();
	if (text) speak(text, key);
}
async function speak(text, key) {
	ttsActiveKey.value = key;
	if (ttsServerEnabled) {
		ttsPhase.value = "loading";
		try {
			const r = await authFetch("/api/tts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text })
			});
			if (!r.ok) throw new Error(`tts ${r.status}`);
			const blob = await r.blob();
			if (ttsActiveKey.value !== key) return;
			const audio = new Audio(URL.createObjectURL(blob));
			ttsCurrentAudio = audio;
			audio.addEventListener("ended", () => {
				if (ttsActiveKey.value === key) stopTts();
			});
			audio.addEventListener("error", () => {
				if (ttsActiveKey.value === key) stopTts();
			});
			ttsPhase.value = "playing";
			await audio.play();
			return;
		} catch (err) {
			console.error("Server TTS failed; falling back to Web Speech", err);
			if (ttsActiveKey.value !== key) return;
		}
	}
	if (typeof window !== "undefined" && "speechSynthesis" in window) {
		const utter = new SpeechSynthesisUtterance(text);
		utter.addEventListener("end", () => {
			if (ttsActiveKey.value === key) stopTts();
		});
		utter.addEventListener("error", () => {
			if (ttsActiveKey.value === key) stopTts();
		});
		ttsPhase.value = "playing";
		window.speechSynthesis.speak(utter);
	} else {
		stopTts();
		showToast("Audio playback failed", { kind: "error" });
	}
}
var sttConfig = null;
var sttActive = false;
var sttStopping = false;
var sttAudioCtx = null;
var sttStream = null;
var sttWorkletNode = null;
var sttSourceNode = null;
var sttBeforeText = "";
var sttCommitted = "";
var sttPending = 0;
var sttSegments = [];
var sttSegmentMs = 0;
var sttSilenceMs = 0;
var sttSpeechInSegment = false;
var sttNoSpeechMs = 0;
var sttInFlight = [];
var sttToastShown = false;
var STT_SAMPLE_RATE = 16e3;
var STT_SILENCE_CUT_MS = 700;
var STT_MAX_SEGMENT_MS = 5e3;
var STT_RMS_FLOOR = .012;
var STT_AUTOSTOP_MS = 12e3;
var sttElapsedTimer = null;
var sttStartedAt = 0;
function sttSetRecordingChrome(on) {
	const mic = $("#mic-btn");
	const chip = $("#stt-elapsed");
	const use = mic?.querySelector("use");
	if (use) use.setAttribute("href", on ? "#i-square" : "#i-mic");
	if (on) {
		sttStartedAt = Date.now();
		if (chip) {
			chip.textContent = "0:00";
			chip.hidden = false;
		}
		sttElapsedTimer = setInterval(() => {
			const sec = Math.floor((Date.now() - sttStartedAt) / 1e3);
			const t = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
			if (chip) chip.textContent = t;
			mic?.setAttribute("title", `Recording ${t} — tap to stop`);
		}, 1e3);
	} else {
		if (sttElapsedTimer) clearInterval(sttElapsedTimer);
		sttElapsedTimer = null;
		if (chip) chip.hidden = true;
		mic?.setAttribute("title", "Dictate");
	}
}
function sttAnnounce(text) {
	const el = $("#stt-status");
	if (el) el.textContent = text;
}
function sttBuildWav(frames) {
	let samples = 0;
	for (const f of frames) samples += f.length;
	const buf = /* @__PURE__ */ new ArrayBuffer(44 + samples * 2);
	const dv = new DataView(buf);
	const writeStr = (off, s) => {
		for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	dv.setUint32(4, 36 + samples * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, 1, true);
	dv.setUint32(24, STT_SAMPLE_RATE, true);
	dv.setUint32(28, STT_SAMPLE_RATE * 2, true);
	dv.setUint16(32, 2, true);
	dv.setUint16(34, 16, true);
	writeStr(36, "data");
	dv.setUint32(40, samples * 2, true);
	let off = 44;
	for (const f of frames) for (let i = 0; i < f.length; i++, off += 2) dv.setInt16(off, f[i], true);
	return new Blob([buf], { type: "audio/wav" });
}
function sttRenderInput() {
	const input = $("#message-input");
	if (!input) return;
	input.value = sttBeforeText + (sttBeforeText && sttCommitted ? " " : "") + sttCommitted + (sttPending > 0 ? " …" : "");
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
function sttCutSegment() {
	const frames = sttSegments;
	const hadSpeech = sttSpeechInSegment;
	sttSegments = [];
	sttSegmentMs = 0;
	sttSilenceMs = 0;
	sttSpeechInSegment = false;
	if (!hadSpeech || frames.length === 0) return;
	const wav = sttBuildWav(frames);
	sttPending++;
	sttRenderInput();
	const p = authFetch("/api/stt/transcribe", {
		method: "POST",
		headers: { "Content-Type": "audio/wav" },
		body: wav
	}).then(async (r) => {
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body.error || r.statusText);
		const text = (body.text || "").trim();
		if (text) sttCommitted = sttCommitted ? `${sttCommitted} ${text}` : text;
	}).catch((err) => {
		if (!sttToastShown) {
			sttToastShown = true;
			showToast("Transcription failed: " + err.message, { kind: "error" });
		}
	}).finally(() => {
		sttPending--;
		sttRenderInput();
	});
	sttInFlight.push(p);
}
function sttOnFrame(int16) {
	if (!sttActive) return;
	let sum = 0;
	for (let i = 0; i < int16.length; i++) {
		const s = int16[i] / 32768;
		sum += s * s;
	}
	const rms = Math.sqrt(sum / int16.length);
	const frameMs = int16.length / STT_SAMPLE_RATE * 1e3;
	sttSegments.push(int16);
	sttSegmentMs += frameMs;
	if (rms >= STT_RMS_FLOOR) {
		sttSpeechInSegment = true;
		sttSilenceMs = 0;
		sttNoSpeechMs = 0;
	} else {
		sttSilenceMs += frameMs;
		sttNoSpeechMs += frameMs;
	}
	if (sttSpeechInSegment && sttSilenceMs >= STT_SILENCE_CUT_MS || sttSegmentMs >= STT_MAX_SEGMENT_MS) sttCutSegment();
	if (sttNoSpeechMs >= STT_AUTOSTOP_MS && !sttStopping) stopDictation();
}
async function startDictation() {
	if (sttActive) return;
	const input = $("#message-input");
	if (!input || input.disabled) return;
	try {
		sttStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		showToast("Microphone access denied — allow the mic for this site in browser settings.", { kind: "error" });
		return;
	}
	try {
		sttAudioCtx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
		await sttAudioCtx.audioWorklet.addModule("/pcm-worklet.js");
		sttSourceNode = sttAudioCtx.createMediaStreamSource(sttStream);
		sttWorkletNode = new AudioWorkletNode(sttAudioCtx, "pcm-worklet");
		sttWorkletNode.port.onmessage = (e) => sttOnFrame(new Int16Array(e.data));
		sttSourceNode.connect(sttWorkletNode);
	} catch (err) {
		showToast("Could not start audio capture: " + err?.message, { kind: "error" });
		sttTeardownAudio();
		return;
	}
	sttActive = true;
	sttStopping = false;
	sttToastShown = false;
	sttBeforeText = input.value.trim();
	sttCommitted = "";
	sttPending = 0;
	sttSegments = [];
	sttSegmentMs = 0;
	sttSilenceMs = 0;
	sttSpeechInSegment = false;
	sttNoSpeechMs = 0;
	sttInFlight = [];
	const mic = $("#mic-btn");
	mic?.classList.add("recording");
	mic?.setAttribute("aria-label", "Stop dictation");
	mic?.setAttribute("aria-pressed", "true");
	sttSetRecordingChrome(true);
	sttAnnounce("Listening…");
}
function sttTeardownAudio() {
	try {
		sttSourceNode?.disconnect();
		sttWorkletNode?.disconnect();
	} catch {}
	sttStream?.getTracks().forEach((t) => t.stop());
	sttAudioCtx?.close().catch(() => {});
	sttStream = null;
	sttAudioCtx = null;
	sttWorkletNode = null;
	sttSourceNode = null;
}
function sttResetMicButton() {
	const mic = $("#mic-btn");
	mic?.classList.remove("recording");
	mic?.setAttribute("aria-label", "Start dictation");
	mic?.setAttribute("aria-pressed", "false");
	sttSetRecordingChrome(false);
}
async function stopDictation() {
	if (!sttActive || sttStopping) return;
	sttStopping = true;
	sttActive = false;
	sttCutSegment();
	sttTeardownAudio();
	sttResetMicButton();
	sttAnnounce("Transcribing…");
	await Promise.allSettled(sttInFlight);
	sttRenderInput();
	await sttCleanupPass();
	sttStopping = false;
	sttAnnounce("");
}
function cancelDictation() {
	if (!sttActive) return;
	sttActive = false;
	sttStopping = false;
	sttTeardownAudio();
	sttResetMicButton();
	sttCommitted = "";
	sttPending = 0;
	const input = $("#message-input");
	if (input) {
		input.value = sttBeforeText;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	sttAnnounce("Dictation cancelled");
}
async function sttCleanupPass() {
	if (!sttConfig?.cleanup || !sttCommitted.trim()) return;
	const input = $("#message-input");
	if (!input) return;
	const raw = sttCommitted;
	const mic = $("#mic-btn");
	mic?.classList.add("tidying");
	try {
		const r = await authFetch("/api/stt/cleanup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: raw })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok || !body.cleaned || typeof body.text !== "string") return;
		const sep = sttBeforeText && raw ? " " : "";
		const expected = sttBeforeText + sep + raw;
		if (input.value !== expected) return;
		const start = (sttBeforeText + sep).length;
		input.focus();
		input.setSelectionRange(start, input.value.length);
		const before = input.value;
		document.execCommand("insertText", false, body.text);
		if (input.value === before) {
			input.setRangeText(body.text, start, before.length, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		sttCommitted = body.text;
	} catch {} finally {
		mic?.classList.remove("tidying");
	}
}
async function initSttFeature() {
	try {
		const r = await authFetch("/api/stt/config");
		if (!r.ok) return;
		sttConfig = await r.json();
		$("#mic-btn").hidden = !sttConfig.enabled;
	} catch {}
}
function getTtsReadAloudEnabled() {
	return ttsReadAloudEnabled;
}
function setTtsReadAloudEnabled(on) {
	ttsReadAloudEnabled = on;
}
function getSttConfig() {
	return sttConfig;
}
function setSttConfig(cfg) {
	sttConfig = cfg;
}
function isDictationActive() {
	return sttActive;
}
//#endregion
//#region src/features/TtsButton.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$66 = [
	"aria-label",
	"title",
	"innerHTML"
];
var VOLUME = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-volume-2\"></use></svg>";
var SQUARE = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-square\"></use></svg>";
//#endregion
//#region src/features/TtsButton.vue
var TtsButton_default = /* @__PURE__ */ defineComponent({
	__name: "TtsButton",
	props: {
		msgKey: {},
		getText: { type: Function }
	},
	setup(__props) {
		/**
		* Read-aloud control on an agent reply, overlaid on the bubble's corner.
		*
		* buildTtsButton() returned null when no TTS path exists, so the button was
		* simply absent; the caller reproduces that with v-if on ttsOffered() rather
		* than rendering a disabled one.
		*
		* Three states, and the markup for each is exactly what resetTtsButton() and
		* markTtsPlaying() used to assign:
		*
		*   idle     volume-2  aria-label/title 'Read aloud'
		*   loading  volume-2  aria-label 'Synthesizing…', title UNCHANGED, +tts-loading
		*   playing  square    aria-label/title 'Stop', +tts-playing
		*
		* The loading state keeping the idle TITLE is not an oversight being tidied up:
		* speak() set only aria-label, and this phase reproduces it.
		*/
		const props = __props;
		const phase = computed(() => ttsActiveKey.value === props.msgKey ? ttsPhase.value : null);
		const cls = computed(() => phase.value === "playing" ? "tts-btn tts-playing" : phase.value === "loading" ? "tts-btn tts-loading" : "tts-btn");
		const label = computed(() => phase.value === "playing" ? "Stop" : phase.value === "loading" ? "Synthesizing…" : "Read aloud");
		const title = computed(() => phase.value === "playing" ? "Stop" : "Read aloud");
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("button", {
				type: "button",
				class: normalizeClass(cls.value),
				"aria-label": label.value,
				title: title.value,
				innerHTML: phase.value === "playing" ? SQUARE : VOLUME,
				onClick: _cache[0] || (_cache[0] = withModifiers(($event) => unref(toggleTts)(props.msgKey, props.getText), ["stop"]))
			}, null, 10, _hoisted_1$66);
		};
	}
});
//#endregion
//#region src/features/MessageBubble.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$65 = { class: "file-bubble" };
var _hoisted_2$57 = ["src", "alt"];
var _hoisted_3$52 = { class: "file-info" };
var _hoisted_4$43 = ["innerHTML"];
var _hoisted_5$32 = { class: "file-name" };
var _hoisted_6$25 = { class: "file-size" };
var _hoisted_7$17 = ["href", "download"];
var _hoisted_8$12 = {
	key: 0,
	class: "file-caption"
};
var _hoisted_9$7 = ["innerHTML"];
var DOWNLOAD = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-download\"></use></svg>";
var IMAGE = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-image\"></use></svg>";
var FILE_TEXT = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-file-text\"></use></svg>";
var PAPERCLIP = "<svg class=\"icon\" aria-hidden=\"true\"><use href=\"#i-paperclip\"></use></svg>";
var DOWNLOAD_TITLE = "Download";
//#endregion
//#region src/features/MessageBubble.vue
var MessageBubble_default = /* @__PURE__ */ defineComponent({
	__name: "MessageBubble",
	props: {
		row: {},
		decorate: { type: Function },
		clampA2a: { type: Function },
		onOpenLightbox: { type: Function }
	},
	setup(__props) {
		/**
		* One message's .bubble, in whichever of its three shapes applies.
		*
		* A component rather than markup repeated inside Transcript, because own
		* messages nest the same bubble inside a .msg-body row and everything else does
		* not — see appendMessage's note on why that row exists even for the optimistic
		* echo.
		*
		* Markdown goes on the bubble ITSELF with v-html, not into a wrapper div. The
		* imperative version assigned bubble.innerHTML, so the markdown nodes were the
		* bubble's own children; a wrapper would change what `.msg .bubble p:last-child`
		* and friends select.
		*
		* Which is why the TTS button is TELEPORTED in. v-html owns the element's
		* children, so the button cannot also be a template child of it — teleporting
		* lands it as the last child exactly where appendChild put it. row.html never
		* changes after append, so v-html never re-runs and never evicts it.
		*
		* The decorators run from the ref callback, in the same position the imperative
		* version called them: immediately after the innerHTML assignment.
		*/
		const props = __props;
		const bubbleEl = ref(null);
		const fileIcon = (m) => m.mime?.startsWith("image/") ? IMAGE : m.mime?.includes("pdf") ? FILE_TEXT : PAPERCLIP;
		const fileSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
		const showTts = () => props.row.isAgent && !!props.row.ttsText && ttsOffered();
		function bind(el) {
			bubbleEl.value = el || null;
			if (!el) return;
			if (props.row.html) props.decorate(el);
			if (props.row.isA2a && el.parentElement) props.clampA2a(el, el.parentElement);
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [__props.row.file ? (openBlock(), createElementBlock("div", {
				key: 0,
				ref_key: "bubbleEl",
				ref: bubbleEl,
				class: "bubble"
			}, [createElementVNode("div", _hoisted_1$65, [__props.row.file.mime?.startsWith("image/") ? (openBlock(), createElementBlock("img", {
				key: 0,
				src: __props.row.file.url,
				alt: __props.row.file.filename,
				class: "file-image-preview",
				loading: "lazy",
				onClick: _cache[0] || (_cache[0] = ($event) => props.onOpenLightbox(__props.row.file.url, __props.row.file.filename))
			}, null, 8, _hoisted_2$57)) : createCommentVNode("", true), createElementVNode("div", _hoisted_3$52, [
				createElementVNode("span", {
					class: "file-icon",
					innerHTML: fileIcon(__props.row.file)
				}, null, 8, _hoisted_4$43),
				createElementVNode("span", _hoisted_5$32, toDisplayString(__props.row.file.filename), 1),
				createElementVNode("span", _hoisted_6$25, toDisplayString(fileSize(__props.row.file.size)), 1),
				createElementVNode("a", {
					href: __props.row.file.url,
					download: __props.row.file.filename,
					class: "file-download",
					title: DOWNLOAD_TITLE,
					innerHTML: DOWNLOAD
				}, null, 8, _hoisted_7$17)
			])]), __props.row.caption ? (openBlock(), createElementBlock("div", _hoisted_8$12, toDisplayString(__props.row.caption), 1)) : createCommentVNode("", true)], 512)) : __props.row.html ? (openBlock(), createElementBlock("div", {
				key: 1,
				ref: bind,
				class: "bubble",
				innerHTML: __props.row.html
			}, null, 8, _hoisted_9$7)) : (openBlock(), createElementBlock("div", {
				key: 2,
				ref: bind,
				class: "bubble"
			}, toDisplayString(__props.row.text), 513)), bubbleEl.value && showTts() ? (openBlock(), createBlock(Teleport, {
				key: 3,
				to: bubbleEl.value
			}, [createVNode(TtsButton_default, {
				"msg-key": __props.row.key,
				"get-text": () => unref(ttsPlainText)(__props.row.ttsText)
			}, null, 8, ["msg-key", "get-text"])], 8, ["to"])) : createCommentVNode("", true)], 64);
		};
	}
});
//#endregion
//#region src/features/MsgDeleteButton.vue?vue&type=script&setup=true&lang.ts
var TRASH = "🗑";
var CONFIRM = "delete?";
var TITLE = "Delete message";
//#endregion
//#region src/features/MsgDeleteButton.vue
var MsgDeleteButton_default = /* @__PURE__ */ defineComponent({
	__name: "MsgDeleteButton",
	props: { messageId: {} },
	setup(__props) {
		/**
		* The 🗑 on your own messages, with its two-step confirm.
		*
		* createDeleteButton() held the confirm in the ELEMENT — a class, a label swap
		* and a 3-second timer closed over the button — which is fine for a node nobody
		* else owns and impossible once the message is Vue-rendered.
		*
		* The timer is per-instance rather than keyed state: only one button can be
		* mid-confirm at a time in practice, but nothing enforced that before either,
		* and a component instance is exactly the scope the closure had.
		*
		* onUnmounted clears it. The old button was garbage with its message; this one
		* can outlive its confirm window if the transcript re-renders under it.
		*/
		const props = __props;
		const confirming = ref(false);
		let timer = null;
		onUnmounted(() => {
			if (timer) clearTimeout(timer);
		});
		function click() {
			if (confirming.value) {
				if (timer) clearTimeout(timer);
				if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
					type: "delete_message",
					message_id: props.messageId
				}));
				return;
			}
			confirming.value = true;
			timer = setTimeout(() => {
				confirming.value = false;
			}, 3e3);
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("button", {
				class: normalizeClass(confirming.value ? "msg-delete confirm" : "msg-delete"),
				title: TITLE,
				onClick: withModifiers(click, ["stop"])
			}, toDisplayString(confirming.value ? CONFIRM : TRASH), 3);
		};
	}
});
//#endregion
//#region src/features/Transcript.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$64 = {
	key: 0,
	class: "empty-state"
};
var _hoisted_2$56 = {
	key: 0,
	class: "msg system"
};
var _hoisted_3$51 = {
	key: 1,
	class: "context-divider"
};
var _hoisted_4$42 = ["data-question-id"];
var _hoisted_5$31 = {
	key: 0,
	class: "approval-inroom-note resolved"
};
var _hoisted_6$24 = {
	key: 2,
	class: "approval-inroom-note"
};
var _hoisted_7$16 = {
	key: 0,
	class: "msg-body"
};
var _hoisted_8$11 = {
	key: 2,
	class: "thoughts"
};
var _hoisted_9$6 = {
	key: 0,
	class: "thoughts-preview"
};
var _hoisted_10$6 = { class: "thoughts-body" };
var _hoisted_11$4 = ["title"];
var THOUGHTS = "Thoughts";
//#endregion
//#region src/features/Transcript.vue
var Transcript_default = /* @__PURE__ */ defineComponent({
	__name: "Transcript",
	props: {
		decorate: { type: Function },
		clampA2a: { type: Function },
		onApprovalRespond: { type: Function },
		onOpenLightbox: { type: Function },
		onStopAgent: { type: Function },
		onToggleTurn: { type: Function }
	},
	setup(__props) {
		/**
		* The transcript — the conversion this whole phase was building toward.
		*
		* Mounted into <div id="messages">, which had TWELVE writers across nine
		* modules. Every other island in this phase owned a container nothing else
		* wrote to; this one could not be sliced, because the moment Vue owns
		* #messages' children every remaining imperative append is a second writer.
		* So appendMessage, appendSystem, the context divider, the thinking bubbles,
		* the file bubble, the thoughts disclosure, the delete button and the TTS
		* button all moved in one change.
		*
		* Rows are VIEW MODELS decided at append time, not raw messages — see
		* transcript-state.ts for why re-deciding later gives different answers.
		*
		* Thinking bubbles render AFTER the list, which is how "insert before the
		* thinking bubble" survives without an anchor: the imperative version had to
		* find the bubble and insertBefore it, and ordering here is just position.
		*
		* Markdown bodies go through v-html. Vue treats that subtree as opaque and
		* never diffs inside it, so decorateCodeBlocks and decorateMentions mutating
		* the rendered HTML is NOT the two-writers problem — they are decorating a
		* black box, and Vue only ever replaces it wholesale when the string changes.
		* That is why those two stay imperative and run from a ref callback.
		*
		* applyA2aClamp also runs from the ref: it measures, so it needs the element
		* attached, which is what the imperative version's post-insert call was for.
		*/
		const props = __props;
		const thoughtsPreview = (lines) => {
			const last = lines[lines.length - 1] || "";
			return last ? " — " + (last.length > 90 ? `${last.slice(0, 89)}…` : last) : "";
		};
		return (_ctx, _cache) => {
			return unref(transcriptEmpty) ? (openBlock(), createElementBlock("div", _hoisted_1$64, toDisplayString(unref(transcriptEmpty)), 1)) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [(openBlock(true), createElementBlock(Fragment, null, renderList(unref(messages), (row) => {
				return openBlock(), createElementBlock(Fragment, { key: row.key }, [row.kind === "system" ? (openBlock(), createElementBlock("div", _hoisted_2$56, toDisplayString(row.text), 1)) : row.kind === "divider" ? (openBlock(), createElementBlock("div", _hoisted_3$51, [createElementVNode("span", null, toDisplayString(row.text), 1)])) : row.kind === "approval" ? (openBlock(), createElementBlock("div", {
					key: 2,
					class: "msg approval-msg",
					"data-question-id": row.id || ""
				}, [row.approvalState === "resolved" ? (openBlock(), createElementBlock("div", _hoisted_5$31, toDisplayString(row.note), 1)) : row.approvalState === "eligible" ? (openBlock(), createBlock(ApprovalCard_default, {
					key: 1,
					approval: row.payload,
					"on-respond": props.onApprovalRespond
				}, null, 8, ["approval", "on-respond"])) : (openBlock(), createElementBlock("div", _hoisted_6$24, toDisplayString(row.note), 1))], 8, _hoisted_4$42)) : (openBlock(), createElementBlock("div", mergeProps({
					key: 3,
					class: row.cls
				}, { ref_for: true }, row.id ? { "data-message-id": row.id } : {}, { style: row.isA2a ? { "--a2a-accent": row.a2aAccent } : void 0 }), [
					createElementVNode("div", { class: normalizeClass(row.isA2a ? "sender a2a-label" : "sender") }, [row.isA2a ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("span", {
						class: "a2a-agent",
						style: normalizeStyle({ color: row.senderColor })
					}, toDisplayString(row.sender), 5), row.a2aTo ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [_cache[0] || (_cache[0] = createElementVNode("span", { class: "a2a-arrow" }, "→", -1)), createElementVNode("span", {
						class: "a2a-agent",
						style: normalizeStyle({ color: row.toColor })
					}, toDisplayString(row.a2aTo), 5)], 64)) : createCommentVNode("", true)], 64)) : row.isAgent ? (openBlock(), createElementBlock(Fragment, { key: 1 }, [_cache[1] || (_cache[1] = createElementVNode("svg", {
						class: "icon",
						"aria-hidden": "true"
					}, [createElementVNode("use", { href: "#i-bot" })], -1)), createTextVNode(toDisplayString(" " + row.sender), 1)], 64)) : (openBlock(), createElementBlock(Fragment, { key: 2 }, [createTextVNode(toDisplayString(row.isMine ? "You" : row.sender), 1)], 64))], 2),
					row.body ? (openBlock(), createElementBlock("div", _hoisted_7$16, [row.id ? (openBlock(), createBlock(MsgDeleteButton_default, {
						key: 0,
						"message-id": row.id
					}, null, 8, ["message-id"])) : createCommentVNode("", true), createVNode(MessageBubble_default, {
						row,
						decorate: props.decorate,
						"clamp-a2a": props.clampA2a,
						"on-open-lightbox": props.onOpenLightbox
					}, null, 8, [
						"row",
						"decorate",
						"clamp-a2a",
						"on-open-lightbox"
					])])) : (openBlock(), createBlock(MessageBubble_default, {
						key: 1,
						row,
						decorate: props.decorate,
						"clamp-a2a": props.clampA2a,
						"on-open-lightbox": props.onOpenLightbox
					}, null, 8, [
						"row",
						"decorate",
						"clamp-a2a",
						"on-open-lightbox"
					])),
					row.thoughts && row.thoughts.length ? (openBlock(), createElementBlock("details", _hoisted_8$11, [createElementVNode("summary", null, [
						_cache[2] || (_cache[2] = createElementVNode("svg", {
							class: "icon",
							"aria-hidden": "true"
						}, [createElementVNode("use", { href: "#i-sparkles" })], -1)),
						createTextVNode(toDisplayString(` ${THOUGHTS} (${row.thoughts.length})`), 1),
						thoughtsPreview(row.thoughts) ? (openBlock(), createElementBlock("span", _hoisted_9$6, toDisplayString(thoughtsPreview(row.thoughts)), 1)) : createCommentVNode("", true)
					]), createElementVNode("div", _hoisted_10$6, [(openBlock(true), createElementBlock(Fragment, null, renderList(row.thoughts, (l, i) => {
						return openBlock(), createElementBlock("div", {
							key: i,
							class: "thoughts-line"
						}, toDisplayString(l), 1);
					}), 128))])])) : createCommentVNode("", true),
					row.timeStr ? (openBlock(), createElementBlock("div", {
						key: 3,
						class: "timestamp",
						title: row.timeTitle || void 0
					}, toDisplayString(row.timeStr), 9, _hoisted_11$4)) : createCommentVNode("", true),
					row.isMine && row.status ? (openBlock(), createElementBlock("div", {
						key: 4,
						class: normalizeClass(row.status === "✓✓" ? "status delivered" : "status")
					}, toDisplayString(row.status), 3)) : createCommentVNode("", true)
				], 16))], 64);
			}), 128)), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(thinkingTurns), (t) => {
				return openBlock(), createBlock(ThinkingBubble_default, {
					key: t.name,
					turn: t,
					"on-stop": props.onStopAgent,
					"on-toggle": props.onToggleTurn
				}, null, 8, [
					"turn",
					"on-stop",
					"on-toggle"
				]);
			}), 128))], 64));
		};
	}
});
//#endregion
//#region src/features/CodeToolbar.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$63 = {
	key: 0,
	class: "code-lang"
};
var COPY$3 = "Copy";
var COPIED$2 = "Copied ✓";
var FAILED$2 = "Failed";
var WRAP = "Wrap";
var UNWRAP = "Unwrap";
var COPY_LABEL$1 = "Copy code to clipboard";
var WRAP_LABEL = "Toggle line wrapping";
//#endregion
//#region src/features/CodeToolbar.vue
var CodeToolbar_default = /* @__PURE__ */ defineComponent({
	__name: "CodeToolbar",
	props: {
		lang: {},
		pre: {}
	},
	setup(__props) {
		/**
		* The Wrap / Copy strip on a fenced code block.
		*
		* Mounted INTO the .code-toolbar div itself, one app per <pre>, so the toolbar
		* element is the host and its children are the component. That keeps the
		* markdown subtree — which Vue holds as opaque v-html and never diffs into —
		* untouched apart from the strip that decorateCodeBlocks was already inserting.
		*
		* The two buttons' feedback used to live in a DELEGATED handler on #messages
		* that wrote btn.textContent and toggled classes: 'Copied ✓' for 1.5s, then
		* back. That handler is gone; both are component state now, which is also why
		* the copy timer can be cleared on unmount instead of firing into a detached
		* node.
		*
		* Wrap toggles a class on the <pre>, not on itself — the CSS rule is
		* `.msg .bubble pre.wrap code`. The component reaches its own host's parent for
		* that, which is the one thing it touches outside its own tree, and it is the
		* same element the delegated handler reached through btn.closest('pre').
		*/
		const props = __props;
		const copyState = ref("idle");
		const wrapping = ref(false);
		let timer = null;
		onUnmounted(() => {
			if (timer) clearTimeout(timer);
		});
		async function copy() {
			const code = props.pre.querySelector("code");
			const ok = await copyTextToClipboard((code ? code.textContent : props.pre.textContent) || "");
			copyState.value = ok ? "copied" : "error";
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				copyState.value = "idle";
			}, 1500);
		}
		function toggleWrap() {
			wrapping.value = !wrapping.value;
			props.pre.classList.toggle("wrap", wrapping.value);
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [
				__props.lang ? (openBlock(), createElementBlock("span", _hoisted_1$63, toDisplayString(__props.lang), 1)) : createCommentVNode("", true),
				createElementVNode("button", {
					type: "button",
					class: normalizeClass(wrapping.value ? "code-btn wrap-code-btn active" : "code-btn wrap-code-btn"),
					"aria-label": WRAP_LABEL,
					onClick: toggleWrap
				}, toDisplayString(wrapping.value ? UNWRAP : WRAP), 3),
				createElementVNode("button", {
					type: "button",
					class: normalizeClass(copyState.value === "idle" ? "code-btn copy-code-btn" : `code-btn copy-code-btn ${copyState.value}`),
					"aria-label": COPY_LABEL$1,
					onClick: copy
				}, toDisplayString(copyState.value === "copied" ? COPIED$2 : copyState.value === "error" ? FAILED$2 : COPY$3), 3)
			], 64);
		};
	}
});
//#endregion
//#region src/features/transcript.ts
var deps$21 = {};
/** Wire the legacy helpers the transcript calls. Call once at startup. */
function provideTranscriptDeps(provided) {
	Object.assign(deps$21, provided);
}
/**
* Give every fenced block a Wrap / Copy strip.
*
* Not a builder any more: it inserts the toolbar element and mounts CodeToolbar
* into it, so the markup and the button feedback are the component's. The
* has-code-toolbar guard is what keeps it idempotent — this runs again whenever
* a bubble re-renders its markdown.
*
* The apps are not tracked for unmount, deliberately: a toolbar lives exactly
* as long as the <pre> inside the v-html subtree that owns it, and that subtree
* is replaced wholesale or not at all.
*/
function decorateCodeBlocks(container) {
	container.querySelectorAll("pre").forEach((pre) => {
		if (pre.classList.contains("has-code-toolbar")) return;
		pre.classList.add("has-code-toolbar");
		const code = pre.querySelector("code");
		const langClass = code && [...code.classList].find((c) => c.startsWith("language-"));
		const lang = langClass ? langClass.slice(9) : "";
		const toolbar = document.createElement("div");
		toolbar.className = "code-toolbar";
		pre.insertBefore(toolbar, pre.firstChild);
		createApp(CodeToolbar_default, {
			lang,
			pre
		}).mount(toolbar);
	});
}
function messageMentionsMe(text) {
	if (!state.myHandle || typeof text !== "string") return false;
	return new RegExp("(?:^|[^a-z0-9_-])@" + state.myHandle + "(?![a-z0-9-])", "i").test(text);
}
var roomSwitchDimTimer;
function beginTranscriptSwitch() {
	const el = $("#messages");
	el.classList.add("room-switching");
	clearTimeout(roomSwitchDimTimer);
	roomSwitchDimTimer = setTimeout(() => el.classList.remove("room-switching"), 2e3);
}
function endTranscriptSwitch() {
	clearTimeout(roomSwitchDimTimer);
	$("#messages").classList.remove("room-switching");
}
function formatTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	const time = d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit"
	});
	const now = /* @__PURE__ */ new Date();
	if (d.toDateString() === now.toDateString()) return time;
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
	const dateOpts = d.getFullYear() === now.getFullYear() ? {
		month: "short",
		day: "numeric"
	} : {
		month: "short",
		day: "numeric",
		year: "numeric"
	};
	return `${d.toLocaleDateString([], dateOpts)}, ${time}`;
}
/**
* Turn a server message into a transcript ROW.
*
* Everything this decides is decided ONCE, here, because it reads state that is
* gone by the next render: whether the sender was me, which agent's reasoning
* log to fold onto the reply, what the a2a payload parsed to. `beforeNode` is
* gone with the DOM — pagination prepends by unshifting instead.
*/
function appendMessage(msg, statusText, prepend) {
	if (msg.type === "system") return appendSystem(msg.message);
	if (msg.message_type === "approval" || msg.message_type === "approval_resolved") return pushRow(approvalRow(msg), prepend);
	if (msg.message_type === "skill_draft") return pushRow(deps$21.skillDraftRow(msg), prepend);
	if (msg.message_type === "context-divider") return pushRow({
		key: nextKey(),
		kind: "divider",
		text: msg.content || "Synced context"
	}, prepend);
	const isMine = msg.sender === state.myIdentity;
	const isA2a = msg.message_type === "a2a" || msg.sender_type === "a2a";
	const isAgent = !isA2a && msg.sender_type === "agent";
	let a2aTo = null;
	let a2aText = msg.content;
	if (isA2a) try {
		const parsed = JSON.parse(msg.content);
		a2aTo = parsed.to ?? null;
		a2aText = typeof parsed.text === "string" ? parsed.text : msg.content;
	} catch {}
	let thoughtsForThisMsg = null;
	if (isAgent) {
		let turn = turnFor(msg.sender);
		if (!turn && thinkingTurns.value.length === 1) turn = thinkingTurns.value[0];
		if (turn) {
			if (turn.reasoningLog.length > 0) thoughtsForThisMsg = turn.reasoningLog.slice();
			deps$21.endAgentTurn(turn.name);
		}
	}
	const body = isA2a ? a2aText : msg.content;
	const isFile = msg.message_type === "file" && !!msg.file_meta;
	let html = null;
	if (!isFile) try {
		html = DOMPurify.sanitize(marked.parse(body), {
			FORBID_TAGS: [
				"form",
				"input",
				"button",
				"select",
				"textarea",
				"option",
				"style"
			],
			FORBID_ATTR: ["style"]
		});
	} catch (err) {
		console.error("Message render failed; falling back to plain text", err);
		html = null;
	}
	const timeStr = formatTime(msg.created_at);
	return pushRow({
		key: nextKey(),
		kind: "msg",
		id: msg.id ?? null,
		cls: (isA2a ? "msg a2a" : isMine ? "msg mine" : isAgent ? "msg agent" : "msg other") + (!isMine && messageMentionsMe(body) ? " mentions-me" : ""),
		isMine,
		isAgent,
		isA2a,
		sender: msg.sender,
		a2aTo,
		a2aAccent: isA2a ? deps$21.agentColor(msg.sender) : void 0,
		senderColor: isA2a ? deps$21.agentColor(msg.sender) : void 0,
		toColor: isA2a && a2aTo ? deps$21.agentColor(a2aTo) : void 0,
		html,
		text: html === null ? body : null,
		file: isFile ? msg.file_meta : null,
		caption: isFile && msg.content && msg.content !== msg.file_meta.filename ? msg.content : null,
		thoughts: thoughtsForThisMsg,
		ttsText: isAgent && msg.content ? msg.content : null,
		timeStr,
		timeTitle: msg.created_at ? new Date(msg.created_at).toLocaleString() : void 0,
		status: isMine && statusText ? statusText : null,
		body: isMine
	}, prepend);
}
/** Append, or PREPEND for older-message pagination — which is what beforeNode
*  expressed when the transcript was a node list. */
function pushRow(row, prepend) {
	if (prepend) messages.value = [row, ...messages.value];
	else messages.value = [...messages.value, row];
	return prepend ? messages.value[0] : messages.value[messages.value.length - 1];
}
/** Drop a row — the upload status line removes itself when the upload ends. */
function removeRow(row) {
	messages.value = messages.value.filter((r) => r.key !== row.key);
}
/** In-room approval card. Actionable for eligible approvers; others see a
*  read-only note, and a resolved card is a static note. */
function approvalRow(msg) {
	let data = {};
	try {
		data = JSON.parse(msg.content ?? "{}") || {};
	} catch {
		data = {};
	}
	const questionId = data.questionId || msg.id || "";
	const resolved = msg.message_type === "approval_resolved" || !!data.resolvedBy;
	const eligible = Array.isArray(data.approvers) && data.approvers.includes(state.myIdentity);
	const who = data.resolvedBy ? " by " + (String(data.resolvedBy).split(":").pop() ?? "").split("@")[0] : "";
	return {
		key: nextKey(),
		kind: "approval",
		id: questionId,
		approvalState: resolved ? "resolved" : eligible ? "eligible" : "awaiting",
		note: resolved ? `🔒 ${data.title || "Approval"} — resolved${who}` : `🔒 ${data.title || "Approval requested"} — awaiting an admin`,
		payload: {
			questionId,
			title: data.title,
			payload: data.question,
			options: data.options
		}
	};
}
function appendSystem(text) {
	return pushRow({
		key: nextKey(),
		kind: "system",
		text
	}, false);
}
var suppressScrollRestore = false;
async function loadOlderMessages() {
	if (state.loadingOlder || state.noMoreOlder || !state.currentRoom || !state.oldestMessageId) return;
	state.loadingOlder = true;
	const el = $("#messages");
	const prevElHeight = el.scrollHeight;
	const prevElTop = el.scrollTop;
	const prevDocHeight = document.documentElement.scrollHeight;
	const prevWinY = window.scrollY;
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/messages?before_id=${encodeURIComponent(state.oldestMessageId)}`);
		if (!r.ok) return;
		const older = await r.json();
		if (!Array.isArray(older) || older.length === 0) {
			state.noMoreOlder = true;
			return;
		}
		const fresh = older.filter((m) => !m.id || !el.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`));
		if (fresh.length === 0) {
			state.noMoreOlder = true;
			return;
		}
		[...fresh].reverse().forEach((m) => appendMessage(m, void 0, true));
		state.oldestMessageId = older[0].id;
		if (older.length < 50) state.noMoreOlder = true;
		if (!suppressScrollRestore) requestAnimationFrame(() => {
			el.scrollTop = prevElTop + (el.scrollHeight - prevElHeight);
			window.scrollTo(0, prevWinY + (document.documentElement.scrollHeight - prevDocHeight));
		});
	} catch {} finally {
		state.loadingOlder = false;
	}
}
async function jumpToMessage(messageId) {
	if (!messageId) return;
	const find = () => $("#messages").querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
	let el = find();
	if (!el) {
		suppressScrollRestore = true;
		try {
			let guard = 0;
			while (!el && !state.noMoreOlder && guard < 40) {
				const before = state.oldestMessageId;
				await loadOlderMessages();
				el = find();
				if (state.oldestMessageId === before) break;
				guard++;
			}
		} finally {
			suppressScrollRestore = false;
		}
	}
	if (!el) {
		showToast("Couldn’t find that message — it may be too old to load.", { kind: "info" });
		return;
	}
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	el.scrollIntoView({ block: "center" });
	el.classList.add("jump-highlight");
	setTimeout(() => el.classList.remove("jump-highlight"), 2500);
}
function scrollToBottom(instant) {
	const el = $("#messages");
	el.scrollTo({
		top: el.scrollHeight,
		behavior: instant ? "instant" : "smooth"
	});
	window.scrollTo({
		top: document.body.scrollHeight,
		behavior: instant ? "instant" : "smooth"
	});
}
function isNearBottom() {
	const el = $("#messages");
	const elNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	const winNear = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
	return elNear && winNear;
}
var pendingFollowScroll = false;
function scheduleFollowScroll() {
	if (pendingFollowScroll) return;
	pendingFollowScroll = true;
	requestAnimationFrame(() => {
		pendingFollowScroll = false;
		if (!state.userScrolledAway) scrollToBottom();
	});
}
function updateScrollButton() {
	if (isNearBottom()) {
		$("#scroll-bottom").hidden = true;
		state.missedMsgCount = 0;
		$("#unread-badge").textContent = "";
	} else {
		$("#scroll-bottom").hidden = false;
		$("#unread-badge").textContent = state.missedMsgCount > 0 ? String(state.missedMsgCount) : "";
	}
}
function incrementMissedMessages() {
	if (!isNearBottom()) {
		state.missedMsgCount = state.missedMsgCount + 1;
		updateScrollButton();
	}
}
function decorateMentions(bubble) {
	const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, { acceptNode(node) {
		let p = node.parentNode;
		while (p && p !== bubble) {
			const tag = p.nodeName;
			if (tag === "CODE" || tag === "PRE") return NodeFilter.FILTER_REJECT;
			p = p.parentNode;
		}
		return NodeFilter.FILTER_ACCEPT;
	} });
	const nodes = [];
	let n;
	while (n = walker.nextNode()) nodes.push(n);
	const re = /(^|\s)@([a-z0-9-]+)\b/gi;
	for (const node of nodes) {
		const txt = node.nodeValue;
		if (!/@[a-z0-9-]/i.test(txt)) continue;
		re.lastIndex = 0;
		let last = 0;
		let m;
		const frag = document.createDocumentFragment();
		let touched = false;
		while ((m = re.exec(txt)) !== null) {
			const fullStart = m.index + m[1].length;
			if (fullStart > last) frag.appendChild(document.createTextNode(txt.slice(last, fullStart)));
			const span = document.createElement("span");
			span.className = "mention";
			const handle = m[2].toLowerCase();
			if (state.myHandle && handle === state.myHandle) span.classList.add("mention-me");
			else {
				const color = deps$21.mentionAgentColor(handle);
				if (color) span.style.background = color;
			}
			span.textContent = `@${m[2]}`;
			frag.appendChild(span);
			last = fullStart + 1 + m[2].length;
			touched = true;
		}
		if (!touched) continue;
		if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
		node.parentNode?.replaceChild(frag, node);
	}
}
var transcriptApp = null;
/**
* Mount the transcript into <div id="messages">, once.
*
* The container itself keeps its imperative flags — .room-switching for the
* switch dim, .drag-over for file drops — because Vue owns an element's
* CHILDREN, not the element. Same split every island in this phase used.
*/
function mountTranscript() {
	if (transcriptApp) return;
	const host = $("#messages");
	if (!host) return;
	transcriptApp = createApp(Transcript_default, {
		decorate: (bubble) => {
			decorateCodeBlocks(bubble);
			decorateMentions(bubble);
		},
		clampA2a: (bubble, container) => applyA2aClamp(bubble, container),
		onApprovalRespond: (questionId, value) => respondToApproval(questionId, value),
		onOpenLightbox: (url, filename) => deps$21.openLightbox(url, filename),
		onStopAgent: (name) => deps$21.interruptAgent(name),
		onToggleTurn: (name) => deps$21.toggleThinkingExpanded(name)
	});
	transcriptApp.mount(host);
}
function wireTranscriptPanel() {
	mountTranscript();
	$("#scroll-bottom")?.addEventListener("click", () => {
		state.missedMsgCount = 0;
		state.userScrolledAway = false;
		clearUserScrollMarkers();
		const badge = $("#unread-badge");
		if (badge) badge.textContent = "";
		scrollToBottom();
	});
	$("#messages")?.addEventListener("load", (e) => {
		if (e.target?.tagName === "IMG") scheduleFollowScroll();
	}, true);
}
var lastUserScrollAt = 0;
var touchMovedThisGesture = false;
var momentumUntil = 0;
/**
* Clear the user-scroll markers so an imminent PROGRAMMATIC scroll is not
* mistaken for a user-driven one by a stale wheel/touch from moments earlier.
*
* Exported because legacy.js's send path needs the same thing before its
* scrollToBottom(). That is one named operation crossing the boundary rather
* than two setters exposing the markers themselves — which is what the 4.1i
* bridge accessors did, and what this slice removes.
*/
function clearUserScrollMarkers() {
	lastUserScrollAt = 0;
	momentumUntil = 0;
}
var markUserScroll = () => {
	lastUserScrollAt = Date.now();
};
function handleScroll() {
	updateScrollButton();
	const el = $("#messages");
	if (!el) return;
	const elScrolls = el.scrollHeight - el.clientHeight > 4;
	const winScrolls = document.documentElement.scrollHeight - window.innerHeight > 4;
	if (elScrolls && el.scrollTop < 80 || winScrolls && window.scrollY < 80) loadOlderMessages();
	const now = Date.now();
	const userDriven = now - lastUserScrollAt < 300 || now < momentumUntil;
	if (!isNearBottom()) {
		if (userDriven) {
			state.userScrolledAway = true;
			state.forceScrollCount = 0;
		}
	} else state.userScrolledAway = false;
}
/** Wheel/touch/key markers and the scroll-follow handler. */
function wireScrollTracking() {
	window.addEventListener("wheel", markUserScroll, { passive: true });
	window.addEventListener("touchstart", () => {
		touchMovedThisGesture = false;
	}, { passive: true });
	window.addEventListener("touchmove", () => {
		touchMovedThisGesture = true;
		markUserScroll();
	}, { passive: true });
	window.addEventListener("touchend", () => {
		if (touchMovedThisGesture) momentumUntil = Date.now() + 1e3;
		touchMovedThisGesture = false;
	}, { passive: true });
	window.addEventListener("keydown", (e) => {
		const t = e.target;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
		if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "PageUp" || e.key === "PageDown" || e.key === "Home" || e.key === "End" || e.key === " ") markUserScroll();
	});
	$("#messages")?.addEventListener("scroll", handleScroll);
	window.addEventListener("scroll", handleScroll);
}
function applyA2aClamp(bubble, container) {
	bubble.classList.add("a2a-clamp", "collapsed");
	if (bubble.scrollHeight <= bubble.clientHeight + 4) {
		bubble.classList.remove("a2a-clamp", "collapsed");
		return;
	}
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "a2a-more";
	toggle.textContent = "Show more";
	toggle.addEventListener("click", () => {
		const collapsed = bubble.classList.toggle("collapsed");
		toggle.textContent = collapsed ? "Show more" : "Show less";
	});
	container.appendChild(toggle);
}
//#endregion
//#region src/features/thinking.ts
var deps$20 = {};
/** Wire the transcript helpers this module calls. Call once, before any turn. */
function provideThinkingDeps(provided) {
	Object.assign(deps$20, provided);
}
var THINKING_DETAIL_MAX = 64;
var REASONING_LOG_MAX = 500;
/**
* Create-or-reuse the turn for one agent. Shared with the heartbeat typing
* path, so activity persists through the turn and clears when the reply lands.
*/
function ensureTurn(name) {
	const key = name || state.agentName || "Agent";
	const existing = turnFor(key);
	if (existing) return existing;
	const shouldScroll = isNearBottom() || isForcedScroll();
	const now = Date.now();
	thinkingTurns.value = [...thinkingTurns.value, {
		name: key,
		startedAt: now,
		lastActivityAt: now,
		verb: "Thinking",
		detail: null,
		milestone: null,
		reasoningLog: [],
		feed: [],
		expanded: false,
		elapsed: "",
		statusLive: false
	}];
	if (shouldScroll) scrollToBottom();
	return turnFor(key);
}
/** Click toggles the full reasoning trace. The trace rebuilds from reasoningLog
*  on every render, so there is nothing to re-render by hand. */
function toggleThinkingExpanded(name) {
	const turn = turnFor(name);
	if (turn) turn.expanded = !turn.expanded;
}
function updateThinkingBubble(name, label, detail) {
	const turn = ensureTurn(name);
	turn.verb = label;
	if (detail) turn.detail = detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, 63)}…` : detail;
	else if (turn.detail) turn.detail = null;
}
function setThinkingMilestone(name, text) {
	ensureTurn(name).milestone = text;
}
var REASONING_FEED_BUFFER = 40;
var REASONING_FEED_TTL = 7e3;
var REASONING_FADE_MS = 500;
function pushReasoning(name, text) {
	const turn = ensureTurn(name);
	turn.reasoningLog.push(text);
	if (turn.reasoningLog.length > REASONING_LOG_MAX) turn.reasoningLog.shift();
	const line = {
		key: nextKey(),
		text,
		fading: false
	};
	turn.feed.push(line);
	while (turn.feed.length > REASONING_FEED_BUFFER) {
		const oldest = turn.feed.shift();
		if (oldest && feedTimers.has(oldest.key)) {
			clearTimeout(feedTimers.get(oldest.key));
			feedTimers.delete(oldest.key);
		}
	}
	feedTimers.set(line.key, setTimeout(() => {
		feedTimers.delete(line.key);
		const l = turn.feed.find((x) => x.key === line.key);
		if (l) l.fading = true;
		setTimeout(() => {
			const i = turn.feed.findIndex((x) => x.key === line.key);
			if (i !== -1) turn.feed.splice(i, 1);
		}, REASONING_FADE_MS);
	}, REASONING_FEED_TTL));
	if (isNearBottom() || isForcedScroll()) scrollToBottom();
}
/** Per-line fade timers, keyed by feed-line key. These hung off the DOM node as
*  `_fadeTimer`; a row has nowhere to hang them, and they must still be
*  cancellable when the buffer trims a line early. */
var feedTimers = /* @__PURE__ */ new Map();
/** Drop a finished turn — its bubble and elapsed timer go with it. */
function removeTurn(name) {
	const turn = turnFor(name);
	if (turn) for (const l of turn.feed) {
		const t = feedTimers.get(l.key);
		if (t) clearTimeout(t);
		feedTimers.delete(l.key);
	}
	thinkingTurns.value = thinkingTurns.value.filter((t) => t.name !== name);
}
function applyMarketplaceNav() {
	const show = state.marketplaceEnabled && isAdminView.value;
	for (const id of [
		"#overflow-mcp",
		"#mtab-mcp-btn",
		"#mtab-skills-btn",
		"#overflow-skills"
	]) {
		const el = $(id);
		if (el) el.hidden = !show;
	}
}
//#endregion
//#region src/features/tool-secrets-state.ts
/** Workspace secrets, or empty for the "No system secrets" note. */
var toolSecretRows = ref([]);
//#endregion
//#region src/features/ToolSecretList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$62 = {
	key: 0,
	class: "skill-desc"
};
var _hoisted_2$55 = { class: "skill-info" };
var _hoisted_3$50 = { class: "skill-head" };
var _hoisted_4$41 = ["onClick"];
var EMPTY$16 = "No system secrets";
var SHARED = "shared";
var REMOVE$7 = "Remove";
//#endregion
//#region src/features/ToolSecretList.vue
var ToolSecretList_default = /* @__PURE__ */ defineComponent({
	__name: "ToolSecretList",
	props: { onRemove: { type: Function } },
	setup(__props) {
		/**
		* Workspace-scoped tool secrets — fifty-seventh island.
		*
		* Mounted into <ul id="secrets-list">, exclusively owned by this module.
		*
		* Every row is 'shared' — this list IS the workspace scope, so unlike
		* AgentSecretList there is no personal/shared distinction to draw and no owner
		* to name. Two lists, two islands, because they answer different questions.
		*
		* loadToolSecretList takes a listSel parameter, but the only selector that ever
		* reaches it is this one: removeToolSecret routes an agent-scoped delete to
		* renderAgentSecrets instead, which repaints the other island. Checked rather
		* than assumed — a second writer into a Vue-owned list is exactly the bug this
		* phase keeps finding.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [unref(toolSecretRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$62, toDisplayString(EMPTY$16))) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(toolSecretRows), (s, i) => {
				return openBlock(), createElementBlock("li", {
					key: i,
					class: "skill-source-row secret-row"
				}, [createElementVNode("div", _hoisted_2$55, [createElementVNode("div", _hoisted_3$50, [createElementVNode("span", null, toDisplayString(s.hostPattern), 1), createElementVNode("span", { class: "skill-badge secret-scope" }, toDisplayString(SHARED))])]), createElementVNode("button", {
					class: "btn btn-danger",
					type: "button",
					onClick: ($event) => props.onRemove(s)
				}, toDisplayString(REMOVE$7), 8, _hoisted_4$41)]);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/perms-user-info.ts
/**
* Prefer the channel-supplied display name, else extract a readable token from
* the namespaced id (handle/email after the last colon).
*/
function userDisplayName(u) {
	if (u.display_name && u.display_name.trim()) return u.display_name.trim();
	const lastColon = u.id.lastIndexOf(":");
	return lastColon >= 0 ? u.id.slice(lastColon + 1) : u.id;
}
function userIsOwner(u) {
	return !!u.roles.find((r) => r.kind === "owner" && r.agent_group_id === null);
}
function userIsGlobalAdmin(u) {
	return !!u.roles.find((r) => r.kind === "admin" && r.agent_group_id === null);
}
function userScopedAdminCount(u) {
	return u.roles.filter((r) => r.kind === "admin" && r.agent_group_id).length;
}
function userMemberCount(u) {
	return u.memberships.length;
}
function findMembership(u, agentGroupId) {
	return u.memberships.find((m) => m.agent_group_id === agentGroupId);
}
function userRoleSummary(u) {
	const parts = [];
	if (userIsOwner(u)) parts.push("owner");
	if (userIsGlobalAdmin(u)) parts.push("global admin");
	const sa = userScopedAdminCount(u);
	if (sa) parts.push(`admin · ${sa} group${sa > 1 ? "s" : ""}`);
	const m = userMemberCount(u);
	if (m) parts.push(`member · ${m} group${m > 1 ? "s" : ""}`);
	return parts.join(" · ") || "no roles";
}
//#endregion
//#region src/features/perms-list-state.ts
/** /api/users, verbatim. */
var permsUsers = ref([]);
/** /api/agents, verbatim — the columns of the per-group matrix. */
var permsAgents = ref([]);
/** Lower-cased search box contents. */
var permsUserFilter = ref("");
/** true = flat A–Z; false = the tiered you/owners/admins/rest order. */
var permsSortAz = ref(false);
/** Selected row, drives both the .active class and which detail is shown. */
var permsSelectedUserId = ref(null);
/** My own user id — drives the YOU tag and the top tier of the sort. */
var permsMyUserId = ref(null);
/** Set when the users fetch fails; replaces the whole list when non-empty. */
var usersError = ref("");
/** The user whose detail pane is open. Null hides the toggles and matrix. */
var permsDetailUser = ref(null);
/** Is the permissions screen open? */
var permsActive = ref(false);
/** Has the user hand-edited the channel field in the create form? Stops the
*  derived value from overwriting a deliberate edit. */
var permsCreateChannelTouched = ref(false);
//#endregion
//#region src/features/room-wired-state.ts
var roomWiredRows = ref([]);
//#endregion
//#region src/features/RoomWiredAgents.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$61 = [
	"title",
	"innerHTML",
	"onClick"
];
var _hoisted_2$54 = [
	"title",
	"onClick",
	"onKeydown"
];
var _hoisted_3$49 = {
	key: 0,
	class: "room-wired-prime-badge"
};
var _hoisted_4$40 = [
	"title",
	"disabled",
	"innerHTML",
	"onClick"
];
//#endregion
//#region src/features/RoomWiredAgents.vue
var RoomWiredAgents_default = /* @__PURE__ */ defineComponent({
	__name: "RoomWiredAgents",
	emits: [
		"prime",
		"open",
		"remove"
	],
	setup(__props, { emit: __emit }) {
		/**
		* Agents wired into the open room, with the prime (★) toggle and remove.
		*
		* Mounted into <ul id="room-wired-agents">. The reply-mode info button lives on
		* the label line OUTSIDE this list, so it stays in renderRoomWiredAgents() —
		* an island owns one container, not everything a render function happened to
		* touch.
		*
		* lucide() returns an SVG string, so the two icon buttons bind it with v-html
		* exactly as the imperative version assigned innerHTML. The star has two
		* variants, so it is computed per row rather than hoisted.
		*/
		const emit = __emit;
		const xIcon = lucide("x");
		const starIcon = (filled) => filled ? lucide("star", "icon--fill") : lucide("star");
		const primeTitle = (a) => a.is_prime ? `Stop ${a.name} replying to everything — back to only when @-mentioned` : `Make ${a.name} the default — replies to all messages (not just @-mentions)`;
		const onlyOne = () => roomWiredRows.value.length <= 1;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(roomWiredRows), (agent) => {
				return openBlock(), createElementBlock("li", { key: agent.id }, [
					createElementVNode("button", {
						type: "button",
						class: normalizeClass("room-wired-prime" + (agent.is_prime ? " active" : "")),
						title: primeTitle(agent),
						innerHTML: starIcon(agent.is_prime),
						onClick: ($event) => emit("prime", agent)
					}, null, 10, _hoisted_1$61),
					createElementVNode("span", {
						class: "room-wired-name room-wired-name-link",
						role: "button",
						tabindex: "0",
						title: `Open ${agent.name} settings`,
						onClick: ($event) => emit("open", agent),
						onKeydown: [withKeys(withModifiers(($event) => emit("open", agent), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => emit("open", agent), ["prevent"]), ["space"])]
					}, [createTextVNode(toDisplayString(agent.name ?? ""), 1), agent.is_prime ? (openBlock(), createElementBlock("span", _hoisted_3$49, " default")) : createCommentVNode("", true)], 40, _hoisted_2$54),
					createElementVNode("button", {
						type: "button",
						class: "room-wired-remove",
						title: onlyOne() ? "Cannot remove the last agent (delete the room instead)" : `Remove ${agent.name}`,
						disabled: onlyOne(),
						innerHTML: unref(xIcon),
						onClick: ($event) => emit("remove", agent)
					}, null, 8, _hoisted_4$40)
				]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AgentList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$60 = [
	"data-agent-id",
	"onClick",
	"onKeydown"
];
var _hoisted_2$53 = ["innerHTML"];
var _hoisted_3$48 = { class: "agent-info" };
var _hoisted_4$39 = { class: "agent-info-name" };
var _hoisted_5$30 = {
	key: 1,
	class: "agent-harness-badge",
	title: "Runs on the OpenCode harness"
};
//#endregion
//#region src/features/AgentList.vue
var AgentList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentList",
	emits: ["pick"],
	setup(__props, { emit: __emit }) {
		/**
		* The agent list — the first Vue island.
		*
		* Mounted into <ul id="agent-list">, which no other module writes to. That
		* exclusivity is why this panel went first: an island and an imperative
		* renderer sharing a container would fight, and the whole of phase 4.1 was
		* about producing containers that one owner controls.
		*
		* It reads state.allAgents directly — that object became shallowReactive in
		* phase 4.0, so pushing a new array into it re-renders this list with no
		* explicit call. The two values that are NOT reactive (the A–Z toggle and the
		* selected agent) are legacy module state; renderAgents() syncs them into refs
		* on each call, which is exactly when the imperative version re-rendered. That
		* keeps renderAgents()'s contract identical for its eight call sites while the
		* implementation stops touching the DOM.
		*/
		const emit = __emit;
		const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));
		/** Name OR folder — the row shows the folder as @handle, so both are searched. */
		const matches = (a, q) => !q || String(a.name ?? "").toLowerCase().includes(q) || String(a.folder ?? "").toLowerCase().includes(q);
		const sorted = computed(() => {
			const q = agentFilter.value.trim().toLowerCase();
			const pool = state.allAgents.filter((a) => matches(a, q));
			return agentSortAz.value ? pool.sort(byName) : pool.sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || byName(a, b));
		});
		const botIcon = lucide("bot");
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(sorted.value, (agent) => {
				return openBlock(), createElementBlock("li", mergeProps({
					key: agent.id,
					"data-agent-id": agent.id
				}, { ref_for: true }, agent.id === unref(selectedAgentId) ? { class: "active" } : {}, {
					role: "button",
					tabindex: "0",
					onClick: ($event) => emit("pick", agent.id),
					onKeydown: [withKeys(withModifiers(($event) => emit("pick", agent.id), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => emit("pick", agent.id), ["prevent"]), ["space"])]
				}), [createElementVNode("span", {
					class: "agent-icon",
					innerHTML: unref(botIcon)
				}, null, 8, _hoisted_2$53), createElementVNode("span", _hoisted_3$48, [
					createElementVNode("span", _hoisted_4$39, toDisplayString(agent.name ?? ""), 1),
					(agent.status || "active") !== "active" ? (openBlock(), createElementBlock("span", {
						key: 0,
						class: normalizeClass(["agent-status-badge", "status-" + (agent.status || "active")])
					}, toDisplayString(agent.status), 3)) : createCommentVNode("", true),
					agent.provider === "opencode" ? (openBlock(), createElementBlock("span", _hoisted_5$30, "OpenCode")) : createCommentVNode("", true)
				])], 16, _hoisted_1$60);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AgentWiredRooms.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$59 = {
	key: 0,
	class: "empty-note"
};
var _hoisted_2$52 = [
	"title",
	"onClick",
	"onKeydown"
];
var _hoisted_3$47 = {
	key: 0,
	class: "room-wired-prime-badge"
};
var _hoisted_4$38 = [
	"title",
	"disabled",
	"innerHTML",
	"onClick"
];
var EMPTY$15 = "Not assigned to any room yet.";
//#endregion
//#region src/features/AgentWiredRooms.vue
var AgentWiredRooms_default = /* @__PURE__ */ defineComponent({
	__name: "AgentWiredRooms",
	props: {
		onOpenRoom: { type: Function },
		onRemoveRoom: { type: Function }
	},
	setup(__props) {
		/**
		* The rooms an agent is wired to — fourteenth island.
		*
		* Mounted into <ul id="agent-wired-rooms">, exclusively owned by this module.
		*
		* #agent-rooms-count and #agent-add-room-toggle are NOT part of this island.
		* They live outside the mount point and agents.ts still sets them imperatively,
		* which is the rule the islands have followed throughout: a component owns the
		* subtree it is mounted on and nothing else.
		*
		* The remove button's icon goes through v-html because lucide() returns SVG
		* markup, exactly as `removeBtn.innerHTML = lucide('x')` did. It is a constant
		* from our own icon set, not user data.
		*/
		const props = __props;
		const XICON = lucide("x");
		const rows = computed(() => wiredRooms.value.map((room) => {
			const onlyAgent = room.agent_count <= 1;
			return {
				id: room.id,
				name: room.name ?? "",
				isPrime: !!room.is_prime,
				openTitle: `Open ${room.name} settings`,
				onlyAgent,
				removeTitle: onlyAgent ? "Cannot unassign — this agent is the room's only agent (delete the room instead)" : `Remove this agent from ${room.name}`
			};
		}));
		function onKey(e, id) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onOpenRoom(id);
			}
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$59, toDisplayString(EMPTY$15))) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", { key: r.id }, [createElementVNode("span", {
					class: "room-wired-name room-wired-name-link",
					role: "button",
					tabindex: "0",
					title: r.openTitle,
					onClick: ($event) => props.onOpenRoom(r.id),
					onKeydown: ($event) => onKey($event, r.id)
				}, [createTextVNode(toDisplayString(r.name), 1), r.isPrime ? (openBlock(), createElementBlock("span", _hoisted_3$47, " default")) : createCommentVNode("", true)], 40, _hoisted_2$52), unref(canManageRooms) ? (openBlock(), createElementBlock("button", {
					key: 0,
					type: "button",
					class: "room-wired-remove",
					title: r.removeTitle,
					disabled: r.onlyAgent,
					innerHTML: unref(XICON),
					onClick: ($event) => props.onRemoveRoom(r.id, r.name)
				}, null, 8, _hoisted_4$38)) : createCommentVNode("", true)]);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/AgentSessions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$58 = {
	key: 0,
	class: "agent-session-row muted"
};
var _hoisted_2$51 = {
	key: 1,
	class: "agent-session-row muted"
};
var _hoisted_3$46 = {
	key: 2,
	class: "agent-session-row muted"
};
var _hoisted_4$37 = { class: "agent-session-meta" };
var _hoisted_5$29 = { class: "agent-session-label" };
var _hoisted_6$23 = { class: "agent-session-sub" };
var _hoisted_7$15 = ["onClick"];
var LOADING$3 = "Loading…";
var EMPTY$14 = "No active sessions.";
var RESET_TITLE = "Reset this session (inject /clear — drops context, next turn starts fresh)";
/**
* Bound, not written as template text. `btn.textContent = 'Reset'` produced
* exactly "Reset"; template text carries the surrounding newlines. This has
* caught three islands already.
*/
var RESET_LABEL = "Reset";
//#endregion
//#region src/features/AgentSessions.vue
var AgentSessions_default = /* @__PURE__ */ defineComponent({
	__name: "AgentSessions",
	props: { onReset: { type: Function } },
	setup(__props) {
		/**
		* An agent's live sessions — fifteenth island.
		*
		* Mounted into <ul id="agent-sessions-list">, exclusively owned by this module.
		*
		* #agent-sessions-count is outside the mount point and stays imperative.
		*
		* The three non-row states — loading, fetch failure, empty — were three
		* different innerHTML writes. They are one phase ref here, which is what stops
		* the "Loading…" row from surviving a failure: the imperative version only
		* cleared it because every exit path happened to overwrite the same element.
		*
		* The sub-line is bound as ONE string rather than "{{ status }} · {{ when }}".
		* Both serialise the same today, but the imperative version put a single text
		* node there and the interpolated form puts three; keeping it one binding means
		* the DOM diff is comparing like for like.
		*/
		const props = __props;
		const rows = computed(() => sessions.value.map((s) => ({
			id: s.id,
			label: s.thread_id ? `thread: ${s.thread_id}` : "main / a2a",
			sub: `${s.container_status || "stopped"} · ${s.last_active ? new Date(s.last_active).toLocaleString() : "—"}`
		})));
		function reset(id, e) {
			props.onReset(id, e.currentTarget);
		}
		return (_ctx, _cache) => {
			return unref(sessionsPhase) === "loading" ? (openBlock(), createElementBlock("li", _hoisted_1$58, toDisplayString(LOADING$3))) : unref(sessionsPhase) === "error" ? (openBlock(), createElementBlock("li", _hoisted_2$51, toDisplayString(unref(sessionsError)), 1)) : rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_3$46, toDisplayString(EMPTY$14))) : (openBlock(true), createElementBlock(Fragment, { key: 3 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.id,
					class: "agent-session-row"
				}, [createElementVNode("div", _hoisted_4$37, [createElementVNode("span", _hoisted_5$29, toDisplayString(r.label), 1), createElementVNode("span", _hoisted_6$23, toDisplayString(r.sub), 1)]), createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost agent-session-reset",
					title: RESET_TITLE,
					onClick: ($event) => reset(r.id, $event)
				}, toDisplayString(RESET_LABEL), 8, _hoisted_7$15)]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/agent-lists-state.ts
/** Unwired, non-archived agents offered when adding to an existing room. */
var addAgentCandidates = ref([]);
/** Non-archived agents offered by the room-create form. */
var createAgentCandidates = ref([]);
/**
* Whether ANY agent exists, archived or not.
*
* Separate from createAgentCandidates because the imperative version keyed its
* empty note off state.allAgents.length, not off the filtered list — so with
* every agent archived it rendered an empty <ul> and no note. That is arguably
* a bug, but harmonising it is a behaviour change and this phase does not make
* those; the flag reproduces it exactly.
*/
var createAgentAnyExist = ref(false);
/**
* Secret rows, already flattened. The imperative version built shared rows and
* per-member personal rows from one local row() helper and appended both to the
* same <ul>; the component sees a single list because that is what the DOM was.
* `scope` is carried through untouched — it is the argument removeToolSecret
* needs, not something the template renders.
*/
var agentSecretRows = ref([]);
/**
* Deploy keys for the open agent, already shaped.
*
* `meta` is composed by the renderer because it was one text node in the
* imperative row; `key` is the untouched API object, which is what the delete
* call takes.
*/
var agentKeyRows = ref([]);
/** Env var NAMES for the open agent — values are never sent to the client. */
var agentEnvNames = ref([]);
/** Names whose delete is in flight. */
var agentEnvDeleting = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/AddAgentPicker.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$57 = {
	key: 0,
	class: "empty-note"
};
var _hoisted_2$50 = ["value", "id"];
var _hoisted_3$45 = ["for"];
var _hoisted_4$36 = { class: "room-add-agent-name" };
var _hoisted_5$28 = { class: "room-add-agent-sub" };
var EMPTY$13 = "No unwired agents — switch to \"New\" to create one.";
//#endregion
//#region src/features/AddAgentPicker.vue
var AddAgentPicker_default = /* @__PURE__ */ defineComponent({
	__name: "AddAgentPicker",
	props: { onToggle: { type: Function } },
	setup(__props) {
		/**
		* The "wire an existing agent" checklist — sixteenth island.
		*
		* Mounted into <ul id="room-add-agent-list">, exclusively owned by this module.
		*
		* The checkboxes stay REAL inputs whose checked state lives in the DOM, exactly
		* as before: updateAddAgentSubmitLabel() and the submit handler both read them
		* with querySelectorAll('input:checked'). Modelling the selection as a ref
		* would mean changing those two readers as well, and the failure mode if one
		* were missed is silent — a submit that wires nothing. Vue only re-renders this
		* list when the candidate refs change, which is the same moment the imperative
		* version rebuilt it and dropped the ticks.
		*
		* #room-add-agent-existing-submit is outside the mount point and stays
		* imperative.
		*/
		const props = __props;
		const rows = computed(() => [...addAgentCandidates.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((a) => ({
			id: a.id,
			cbId: `room-add-agent-${a.id}`,
			name: a.name || a.id,
			sub: a.folder || a.id
		})));
		return (_ctx, _cache) => {
			return rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$57, toDisplayString(EMPTY$13))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.id,
					class: "room-add-agent-row"
				}, [createElementVNode("input", {
					type: "checkbox",
					value: r.id,
					id: r.cbId,
					onChange: _cache[0] || (_cache[0] = ($event) => props.onToggle())
				}, null, 40, _hoisted_2$50), createElementVNode("label", {
					for: r.cbId,
					class: "room-add-agent-label"
				}, [createElementVNode("span", _hoisted_4$36, toDisplayString(r.name), 1), createElementVNode("span", _hoisted_5$28, toDisplayString(r.sub), 1)], 8, _hoisted_3$45)]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/RoomCreateAgentChecklist.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$56 = {
	key: 0,
	class: "empty-note"
};
var _hoisted_2$49 = ["value", "id"];
var _hoisted_3$44 = ["for"];
var EMPTY$12 = "No agents yet — create one inline below.";
//#endregion
//#region src/features/RoomCreateAgentChecklist.vue
var RoomCreateAgentChecklist_default = /* @__PURE__ */ defineComponent({
	__name: "RoomCreateAgentChecklist",
	setup(__props) {
		/**
		* The room-create form's "which existing agents" checklist — seventeenth
		* island.
		*
		* Mounted into <ul id="room-create-existing-agents">, exclusively owned by this
		* module.
		*
		* Same contract as AddAgentPicker: the ticks live in the DOM because the submit
		* handler reads them with querySelectorAll. These rows carry no change
		* listener at all — the imperative version attached none either, so this island
		* adds no listeners to the boot set.
		*
		* Two things copied rather than harmonised, both because changing them would be
		* a behaviour change this phase does not make:
		*   - the label is agent.name with a '' fallback, not `name || id`
		*   - the empty note keys off whether ANY agent exists, not off the filtered
		*     list, so every-agent-archived renders an empty <ul> with no note
		*/
		const rows = computed(() => [...createAgentCandidates.value].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map((a) => ({
			id: a.id,
			cbId: `room-create-agent-${a.id}`,
			label: a.name ?? ""
		})));
		return (_ctx, _cache) => {
			return !unref(createAgentAnyExist) ? (openBlock(), createElementBlock("li", _hoisted_1$56, toDisplayString(EMPTY$12))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", { key: r.id }, [createElementVNode("input", {
					type: "checkbox",
					value: r.id,
					id: r.cbId
				}, null, 8, _hoisted_2$49), createElementVNode("label", { for: r.cbId }, toDisplayString(r.label), 9, _hoisted_3$44)]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/AgentSecretList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$55 = { class: "skill-info" };
var _hoisted_2$48 = { class: "skill-head" };
var _hoisted_3$43 = {
	key: 0,
	class: "skill-desc"
};
var _hoisted_4$35 = ["onClick"];
var REMOVE$6 = "Remove";
//#endregion
//#region src/features/AgentSecretList.vue
var AgentSecretList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentSecretList",
	props: { onRemove: { type: Function } },
	setup(__props) {
		/**
		* An agent's tool secrets — eighteenth island.
		*
		* Mounted into <ul id="agent-secrets-list">, exclusively owned by this module.
		*
		* The imperative version had a local row() helper and called it twice: once per
		* shared secret, then once per member secret with `personal` set. Both appended
		* to the same <ul>, so the DOM was always one flat list — the rows arrive here
		* already flattened and the component does not know there were two loops.
		*
		* No empty state, deliberately. The original rendered nothing when both loops
		* were empty, and adding a note here would be new UI rather than a conversion.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(agentSecretRows), (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.key,
					class: "skill-source-row secret-row"
				}, [createElementVNode("div", _hoisted_1$55, [createElementVNode("div", _hoisted_2$48, [createElementVNode("span", null, toDisplayString(r.host), 1), createElementVNode("span", { class: normalizeClass(`skill-badge secret-scope${r.personal ? " skill-badge-user" : ""}`) }, toDisplayString(r.personal ? "personal" : "shared"), 3)]), r.personal ? (openBlock(), createElementBlock("span", _hoisted_3$43, toDisplayString(r.ownerLabel), 1)) : createCommentVNode("", true)]), createElementVNode("button", {
					class: "btn btn-danger",
					type: "button",
					onClick: ($event) => props.onRemove(r)
				}, toDisplayString(REMOVE$6), 8, _hoisted_4$35)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AgentEnvList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$54 = ["disabled", "onClick"];
var REMOVE$5 = "Remove";
//#endregion
//#region src/features/AgentEnvList.vue
var AgentEnvList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentEnvList",
	props: { onRemove: { type: Function } },
	setup(__props) {
		/**
		* An agent's environment variables — fiftieth island.
		*
		* Mounted into <div id="agent-env-list">, exclusively owned by this module.
		* #agent-env-count and the save control are outside it and stay imperative.
		*
		* NAMES only. The server never sends values, and the row shows `$NAME` — the
		* point of the panel is which variables exist, not what they hold.
		*
		* The delete button disables itself while its request is in flight and
		* re-enables on failure, exactly as before; on success the list re-renders and
		* the row is gone. Keyed by name because that is what the endpoint takes.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(agentEnvNames), (name) => {
				return openBlock(), createElementBlock("div", {
					key: name,
					class: "secret-row"
				}, [createElementVNode("code", null, "$" + toDisplayString(name), 1), createElementVNode("button", {
					class: "btn btn-ghost",
					type: "button",
					disabled: unref(agentEnvDeleting).has(name) || void 0,
					onClick: ($event) => props.onRemove(name)
				}, toDisplayString(REMOVE$5), 8, _hoisted_1$54)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AgentKeyList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$53 = { class: "skill-info" };
var _hoisted_2$47 = { class: "skill-head" };
var _hoisted_3$42 = { class: "skill-desc" };
var _hoisted_4$34 = { class: "secret-actions" };
var _hoisted_5$27 = ["onClick"];
var _hoisted_6$22 = ["onClick"];
var COPY$2 = "Copy public key";
var REMOVE$4 = "Remove";
//#endregion
//#region src/features/AgentKeyList.vue
var AgentKeyList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentKeyList",
	props: {
		onCopy: { type: Function },
		onRemove: { type: Function }
	},
	setup(__props) {
		/**
		* An agent's SSH deploy keys — sixtieth island.
		*
		* Mounted into <ul id="agent-keys-list">, exclusively owned by this module.
		* #agent-keys-count sits outside the mount point and keeps its imperative
		* write: it SETS text on static markup rather than building anything.
		*
		* The row builder lived in legacy.js and was reached through the deps bridge —
		* agents.ts called deps.deployKeyRowEl() per key. That indirection is what the
		* island removes; the shaping now happens in renderAgentKeys and the markup
		* lives here.
		*
		* The private half of the keypair never reaches the client, so "Copy public
		* key" is the whole workflow — it is the half you paste into authorized_keys
		* or a git host — which is why it takes the prominent button and Remove takes
		* the danger one.
		*
		* The meta line carries the ready-to-paste ssh command when a login target is
		* set and falls back to the path plus a note when it is not. It is composed in
		* renderAgentKeys rather than here: it is one string in the DOM, and splitting
		* it across template nodes would put text nodes where the original had one.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(agentKeyRows), (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.name,
					class: "skill-source-row secret-row"
				}, [createElementVNode("div", _hoisted_1$53, [createElementVNode("div", _hoisted_2$47, toDisplayString(r.name), 1), createElementVNode("span", _hoisted_3$42, toDisplayString(r.meta), 1)]), createElementVNode("div", _hoisted_4$34, [createElementVNode("button", {
					class: "btn btn-secondary",
					type: "button",
					onClick: ($event) => props.onCopy(r)
				}, toDisplayString(COPY$2), 8, _hoisted_5$27), createElementVNode("button", {
					class: "btn btn-danger",
					type: "button",
					onClick: ($event) => props.onRemove(r)
				}, toDisplayString(REMOVE$4), 8, _hoisted_6$22)])]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/probe-results-state.ts
/** One row per advertised model: the id and its default display name. */
var probeRows = ref([]);
/** Pre-check when the endpoint advertises exactly one model. */
var probeSingle = ref(false);
/** Empty-state copy — differs when the endpoint is credential-gated. */
var probeEmptyNote = ref("");
//#endregion
//#region src/features/ProbeResults.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$52 = {
	key: 0,
	class: "empty-note"
};
var _hoisted_2$46 = ["value", "checked"];
var _hoisted_3$41 = ["data-model-id"];
var NAME_PLACEHOLDER = "Display name";
//#endregion
//#region src/features/ProbeResults.vue
var ProbeResults_default = /* @__PURE__ */ defineComponent({
	__name: "ProbeResults",
	setup(__props) {
		/**
		* The endpoint probe's model checklist — fifty-third island.
		*
		* Mounted into <ul id="model-probe-list">, exclusively owned by this module.
		* The summary line above it (#model-probe-results .model-probe-summary) and the
		* panel's hidden flag stay imperative — both are outside the list.
		*
		* The checkboxes and name inputs keep their state in the DOM: the submit path
		* reads them with querySelectorAll and pulls the display name off each input.
		* Same contract as the agent pickers, and the same reason — modelling the
		* selection as state would mean changing a reader elsewhere, and the failure is
		* silent (a probe that registers nothing you ticked).
		*
		* One accepted difference: Vue emits a `checked` ATTRIBUTE where the imperative
		* version set only the property. Same call as 4.2c and 4.3b, on the same
		* evidence — the submit path reads the property, and the property matches.
		*
		* A single advertised model is pre-checked, because the one-model case is the
		* common one and unticking is cheaper than hunting for the box.
		*/
		const FLEX = { flex: "1" };
		/**
		* The default display name is ASSIGNED as a property, not bound. `value` on an
		* input renders as an ATTRIBUTE under Vue, and the imperative version set only
		* the property — same call made for the skill editor's textarea in 4.3a. The
		* field is uncontrolled either way: nothing re-reads it after the probe.
		*/
		function setName(el, name) {
			if (el && el.value === "") el.value = name;
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [unref(probeRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$52, toDisplayString(unref(probeEmptyNote)), 1)) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(probeRows), (r) => {
				return openBlock(), createElementBlock("li", { key: r.modelId }, [createElementVNode("label", null, [createElementVNode("input", {
					type: "checkbox",
					value: r.modelId,
					checked: unref(probeSingle)
				}, null, 8, _hoisted_2$46), createElementVNode("span", { style: FLEX }, toDisplayString(r.modelId), 1)]), createElementVNode("input", {
					type: "text",
					ref_for: true,
					ref: (el) => setName(el, r.name),
					placeholder: NAME_PLACEHOLDER,
					"data-model-id": r.modelId
				}, null, 8, _hoisted_3$41)]);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/model-picker-state.ts
/** Rows in display order — the Default row is always first. */
var pickerRows = ref([]);
/** The model id currently assigned, '' for Default. */
var pickerSelected = ref("");
/** Empty-state copy, or '' when rows should show. */
var pickerEmptyNote = ref("");
//#endregion
//#region src/features/ModelPicker.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$51 = [
	"data-model-id",
	"onClick",
	"onKeydown"
];
var _hoisted_2$45 = { class: "model-picker-row-top" };
var _hoisted_3$40 = { class: "model-picker-row-name" };
var _hoisted_4$33 = { class: "model-picker-row-sub" };
var _hoisted_5$26 = {
	key: 0,
	class: "model-picker-empty"
};
//#endregion
//#region src/features/ModelPicker.vue
var ModelPicker_default = /* @__PURE__ */ defineComponent({
	__name: "ModelPicker",
	props: { onPick: { type: Function } },
	setup(__props) {
		/**
		* The agent's model picker — fifty-fourth island.
		*
		* Mounted into <ul id="model-picker-list">, exclusively owned by this module.
		*
		* The Default row is pinned at the top and is NEVER filtered out, even with a
		* search query — the user may be searching precisely to confirm that nothing
		* matches and the fallback is what they want. It is shaped upstream and enters
		* the list like any other row.
		*
		* The empty note can appear ALONGSIDE the Default row: "no matches" is about
		* the registered models, not about the list being empty. That is why it renders
		* between Default and the matches rather than replacing everything.
		*/
		const props = __props;
		function rowClass(r) {
			const parts = ["model-picker-row"];
			if (r.isDefault) parts.push("is-default");
			if ((r.id || "") === pickerSelected.value) parts.push("selected");
			return parts.join(" ");
		}
		function onKey(e, id) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onPick(id);
			}
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(pickerRows), (r) => {
				return openBlock(), createElementBlock(Fragment, { key: r.key }, [createElementVNode("li", {
					class: normalizeClass(rowClass(r)),
					tabindex: "0",
					"data-model-id": r.id || "",
					onClick: ($event) => props.onPick(r.id || ""),
					onKeydown: ($event) => onKey($event, r.id || "")
				}, [createElementVNode("div", _hoisted_2$45, [createElementVNode("span", _hoisted_3$40, toDisplayString(r.name), 1), createElementVNode("span", { class: normalizeClass(r.badgeClass) }, toDisplayString(r.badgeText), 3)]), createElementVNode("div", _hoisted_4$33, toDisplayString(r.sub), 1)], 42, _hoisted_1$51), r.isDefault && unref(pickerEmptyNote) ? (openBlock(), createElementBlock("li", _hoisted_5$26, toDisplayString(unref(pickerEmptyNote)), 1)) : createCommentVNode("", true)], 64);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/reachability-state.ts
/** 'checking' while the probe runs, then 'error' or 'outcome'. */
var reachPhase = ref("checking");
/** Message for the error phase. */
var reachError = ref("");
/** Verdict line, plus the copy-paste fix when there is one. */
var reachOutcome = ref(null);
//#endregion
//#region src/features/Reachability.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$50 = {
	key: 0,
	class: "model-reachability-result"
};
var _hoisted_2$44 = {
	key: 1,
	class: "model-reachability-result warn"
};
var _hoisted_3$39 = { class: "model-reachability-verdict" };
var _hoisted_4$32 = { class: "model-reachability-fix" };
var CHECKING = "Checking reachability…";
var COPY$1 = "Copy fix";
var COPIED$1 = "Copied";
//#endregion
//#region src/features/Reachability.vue
var Reachability_default = /* @__PURE__ */ defineComponent({
	__name: "Reachability",
	props: { onCopy: { type: Function } },
	setup(__props) {
		/**
		* The model endpoint reachability verdict — fifty-fifth island.
		*
		* Mounted into #model-reachability-panel, which legacy CREATES once and inserts
		* after #model-live-facts. The panel itself and its hidden flag stay imperative:
		* whether to probe at all is a decision about the model (only endpoints an agent
		* dials directly are meaningful — hosted Anthropic models have none).
		*
		* renderReachabilityOutcome is absorbed. Three phases in one element, which the
		* imperative version expressed by clearing and repainting `out`: the wait line,
		* a transport/HTTP error, and the verdict.
		*
		* The fix block is a copy-paste command, so the copy button matters more than it
		* looks — it is how the operator applies the remedy. 'Copied' for 1500ms, and a
		* toast if the clipboard write is refused.
		*/
		const props = __props;
		const copyLabel = ref(COPY$1);
		let timer = null;
		async function copy(fix) {
			if (!await props.onCopy(fix)) return;
			copyLabel.value = COPIED$1;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => copyLabel.value = COPY$1, 1500);
		}
		return (_ctx, _cache) => {
			return unref(reachPhase) === "checking" ? (openBlock(), createElementBlock("div", _hoisted_1$50, toDisplayString(CHECKING))) : unref(reachPhase) === "error" ? (openBlock(), createElementBlock("div", _hoisted_2$44, toDisplayString(unref(reachError)), 1)) : unref(reachOutcome) ? (openBlock(), createElementBlock("div", {
				key: 2,
				class: normalizeClass(unref(reachOutcome).warn ? "model-reachability-result warn" : "model-reachability-result")
			}, [createElementVNode("div", _hoisted_3$39, toDisplayString(`${unref(reachOutcome).warn ? "✕" : "✓"} ${unref(reachOutcome).label} — ${unref(reachOutcome).detail}`), 1), unref(reachOutcome).fix ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("pre", _hoisted_4$32, toDisplayString(unref(reachOutcome).fix), 1), createElementVNode("button", {
				type: "button",
				class: "btn btn-ghost",
				onClick: _cache[0] || (_cache[0] = ($event) => copy(unref(reachOutcome).fix))
			}, toDisplayString(copyLabel.value), 1)], 64)) : createCommentVNode("", true)], 2)) : createCommentVNode("", true);
		};
	}
});
//#endregion
//#region src/features/ModelList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$49 = {
	key: 0,
	style: {
		cursor: "default",
		opacity: .6
	}
};
var _hoisted_2$43 = [
	"data-model-id",
	"onClick",
	"onKeydown"
];
var _hoisted_3$38 = { class: "model-row-name" };
var _hoisted_4$31 = {
	key: 0,
	class: "model-row-hint"
};
var _hoisted_5$25 = {
	key: 1,
	class: "model-row-host"
};
var _hoisted_6$21 = {
	key: 2,
	class: "model-row-uses"
};
var _hoisted_7$14 = ["onClick"];
var REMOVE_GLYPH$1 = "−";
var EMPTY$11 = "No models selected yet — use + on a server below, or “Add model endpoint…” for anything else.";
//#endregion
//#region src/features/ModelList.vue
var ModelList_default = /* @__PURE__ */ defineComponent({
	__name: "ModelList",
	emits: ["pick", "remove"],
	setup(__props, { emit: __emit }) {
		/**
		* The model list — fourth island, and the first with a nested interactive
		* control (the − remove button) inside each row.
		*
		* Mounted into <ul id="model-list">, exclusively owned by this module.
		*
		* The remove button disables itself through the event target, exactly as the
		* imperative version did, rather than through per-row reactive state: the
		* disabled flag is transient UI feedback for one in-flight request, not
		* application state, and routing it through a ref would outlive the request.
		*/
		const emit = __emit;
		function onRemove(ev, id) {
			ev.stopPropagation();
			emit("remove", id, ev.currentTarget);
		}
		return (_ctx, _cache) => {
			return unref(modelRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$49, toDisplayString(EMPTY$11))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(modelRows), (row) => {
				return openBlock(), createElementBlock("li", mergeProps({
					key: row.id,
					"data-model-id": row.id
				}, { ref_for: true }, row.active ? { class: "active" } : {}, {
					role: "button",
					tabindex: "0",
					onClick: ($event) => emit("pick", row.id),
					onKeydown: [withKeys(withModifiers(($event) => emit("pick", row.id), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => emit("pick", row.id), ["prevent"]), ["space"])]
				}), [
					createElementVNode("span", { class: normalizeClass(`model-kind-badge kind-${row.badgeKind}`) }, toDisplayString(row.badgeText), 3),
					createElementVNode("span", _hoisted_3$38, toDisplayString(row.title), 1),
					row.hint ? (openBlock(), createElementBlock("span", _hoisted_4$31, toDisplayString(row.hint), 1)) : row.host ? (openBlock(), createElementBlock("span", _hoisted_5$25, toDisplayString(row.host), 1)) : createCommentVNode("", true),
					row.uses > 0 ? (openBlock(), createElementBlock("span", _hoisted_6$21, toDisplayString(row.uses) + "×", 1)) : createCommentVNode("", true),
					createElementVNode("button", {
						type: "button",
						class: "btn btn-ghost select-toggle on",
						title: "Remove from selectable models",
						"aria-label": "Remove from selectable models",
						onClick: ($event) => onRemove($event, row.id)
					}, toDisplayString(REMOVE_GLYPH$1), 8, _hoisted_7$14)
				], 16, _hoisted_2$43);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/file-preview-state.ts
var previewRows = ref([]);
//#endregion
//#region src/features/FilePreview.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$48 = ["data-id"];
var _hoisted_2$42 = ["src"];
var _hoisted_3$37 = ["innerHTML"];
var _hoisted_4$30 = { class: "file-preview-name" };
var _hoisted_5$24 = { class: "file-preview-size" };
var _hoisted_6$20 = [
	"data-remove-id",
	"innerHTML",
	"onClick"
];
//#endregion
//#region src/features/FilePreview.vue
var FilePreview_default = /* @__PURE__ */ defineComponent({
	__name: "FilePreview",
	emits: ["remove"],
	setup(__props, { emit: __emit }) {
		/**
		* Staged-file thumbnails above the composer.
		*
		* Mounted into <div id="file-preview">. Rows arrive with thumbUrl already
		* resolved — files.ts owns the pendingThumbUrls map and revokes those URLs on
		* clear, so minting them here would leak one per re-render.
		*
		* Non-image rows show the paperclip icon and the remove button shows the x
		* icon; both are lucide() SVG strings, bound with v-html as the imperative
		* version assigned them into an innerHTML blob.
		*/
		const emit = __emit;
		const clipIcon = lucide("paperclip");
		const xIcon = lucide("x");
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(previewRows), (r) => {
				return openBlock(), createElementBlock("div", {
					key: r.id,
					class: "file-preview-content",
					"data-id": r.id
				}, [
					r.thumbUrl ? (openBlock(), createElementBlock("img", {
						key: 0,
						src: r.thumbUrl,
						class: "file-preview-thumb",
						alt: ""
					}, null, 8, _hoisted_2$42)) : (openBlock(), createElementBlock("span", {
						key: 1,
						class: "file-preview-icon",
						innerHTML: unref(clipIcon)
					}, null, 8, _hoisted_3$37)),
					createElementVNode("span", _hoisted_4$30, toDisplayString(r.name), 1),
					createElementVNode("span", _hoisted_5$24, toDisplayString(r.size), 1),
					createElementVNode("button", {
						class: "file-preview-remove",
						"data-remove-id": r.id,
						innerHTML: unref(xIcon),
						onClick: ($event) => emit("remove", r.id)
					}, null, 8, _hoisted_6$20)
				], 8, _hoisted_1$48);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AttachPicker.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$47 = {
	key: 0,
	class: "model-picker-empty"
};
var _hoisted_2$41 = ["onClick", "onKeydown"];
var _hoisted_3$36 = { class: "model-picker-row-top" };
var _hoisted_4$29 = { class: "model-picker-row-name" };
var _hoisted_5$23 = { class: "attach-picker-toggle" };
var _hoisted_6$19 = {
	key: 0,
	class: "model-picker-row-sub"
};
//#endregion
//#region src/features/AttachPicker.vue
var AttachPicker_default = /* @__PURE__ */ defineComponent({
	__name: "AttachPicker",
	emits: ["toggle"],
	setup(__props, { emit: __emit }) {
		/**
		* The attach picker's row list — used by several panels through a config
		* object (items / searchText / name / meta / isAttached / onToggle).
		*
		* Mounted into <ul id="attach-picker-list">. The rows arrive PRE-SHAPED:
		* resolving the config belongs to the caller that supplied it, not to a
		* component that would then need to know every panel's item type.
		*
		* The imperative version disabled a row mid-flight with
		* `li.style.pointerEvents = 'none'` and then re-rendered itself. Here the row
		* emits and the caller re-syncs the refs — a re-render is a data change, not a
		* function call.
		*/
		const emit = __emit;
		function act(ev, r) {
			const li = ev.currentTarget;
			li.style.pointerEvents = "none";
			emit("toggle", r.key, r.attached, li);
		}
		return (_ctx, _cache) => {
			return unref(attachRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$47, toDisplayString(unref(attachEmptyText)), 1)) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(attachRows), (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.key,
					class: normalizeClass("model-picker-row attach-picker-row" + (r.attached ? " selected" : "")),
					tabindex: "0",
					onClick: ($event) => act($event, r),
					onKeydown: [withKeys(withModifiers(($event) => act($event, r), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => act($event, r), ["prevent"]), ["space"])]
				}, [createElementVNode("div", _hoisted_3$36, [createElementVNode("span", _hoisted_4$29, toDisplayString(r.name), 1), createElementVNode("span", _hoisted_5$23, toDisplayString(r.attached ? "−" : "+"), 1)]), r.meta ? (openBlock(), createElementBlock("div", _hoisted_6$19, toDisplayString(r.meta), 1)) : createCommentVNode("", true)], 42, _hoisted_2$41);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/search-results-state.ts
var searchRows = ref([]);
//#endregion
//#region src/features/SearchResults.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$46 = {
	key: 0,
	class: "search-empty"
};
var _hoisted_2$40 = [
	"data-room-id",
	"data-room-name",
	"data-message-id"
];
var _hoisted_3$35 = { class: "search-result-head" };
var _hoisted_4$28 = { class: "search-result-room" };
var _hoisted_5$22 = { class: "search-result-time" };
var _hoisted_6$18 = ["innerHTML"];
var EMPTY$10 = "No matches";
//#endregion
//#region src/features/SearchResults.vue
var SearchResults_default = /* @__PURE__ */ defineComponent({
	__name: "SearchResults",
	setup(__props) {
		/**
		* Room-search results.
		*
		* Mounted into <ul id="search-results">. The container keeps its DELEGATED
		* click listener — Vue replaces the container's children, not the container, so
		* a listener bound to the <ul> itself survives the mount and keeps working.
		*
		* The snippet line is a single v-html on the snip DIV, not a sender span plus a
		* v-html span beside it. The wrapper span that second form adds is a real
		* structural difference from the imperative markup — caught by the DOM diff —
		* and there is no way to v-html without an element, so the whole inner HTML is
		* shaped in rooms.ts instead.
		*
		* That is also where it belongs: FTS5 returns «…» markers around matches, and
		* the imperative version escaped the text FIRST and only then replaced the
		* markers with <mark>. That order is the XSS guarantee, so it stays next to the
		* escaping it depends on, and this component receives HTML it may not build.
		*/
		return (_ctx, _cache) => {
			return unref(searchRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$46, toDisplayString(EMPTY$10))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(searchRows), (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.id,
					class: "search-result",
					"data-room-id": r.roomId,
					"data-room-name": r.roomName,
					"data-message-id": r.id
				}, [createElementVNode("div", _hoisted_3$35, [createElementVNode("span", _hoisted_4$28, "#" + toDisplayString(r.roomName), 1), createElementVNode("span", _hoisted_5$22, toDisplayString(r.time), 1)]), createElementVNode("div", {
					class: "search-result-snip",
					innerHTML: r.snipHtml
				}, null, 8, _hoisted_6$18)], 8, _hoisted_2$40);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/user-creds-state.ts
/** Provider the panel is showing. Defaults to 'claude' — the workspace's
*  primary — not to empty; an empty default renders a provider-less panel. */
var userCredsProvider = ref("claude");
/**
* The panel's rendered shape, or null when there is nothing to offer.
*
* Typed from the two places that assign it, not guessed: an object carrying
* `offered`, `connected`, `provider`, `oauthAllowed`, `apiOffered` and the two
* label words. My first guess was a state-machine string and the compiler said
* otherwise — the fourth interface in this project to be corrected by the code
* it describes.
*/
var userCredsState = ref(null);
/** Whether THIS member has a credential connected. A flag, not a list. */
var userCredsConnected = ref(false);
/**
* The in-flight OAuth attempt. sessionId correlates the popup's callback with
* the dialog that opened it; target names the provider; returnFocus is the
* element to restore focus to when the popup closes, which is why it is a live
* element reference and not an id.
*/
var userCredsOauthSessionId = ref(null);
/** 'member' or 'workspace' — whose credential the mint is for. Defaults to
*  'member', which is the flow the panel opens in. */
var userCredsOauthTarget = ref("member");
var userCredsOauthReturnFocus = ref(null);
/**
* Provider vocabulary for the panel and the mint dialog.
*
* Lives here rather than in members.ts because modals.ts needs it too, and
* modals→members would close a cycle (members already imports modals). A leaf
* module both can import is what let the bridge entry go.
*/
function userCredsWords(provider) {
	return provider === "codex" ? {
		name: "Codex",
		subWord: "ChatGPT subscription",
		keyWord: "OpenAI key",
		keyPlaceholder: "sk-…"
	} : {
		name: "Claude",
		subWord: "Claude subscription",
		keyWord: "Anthropic key",
		keyPlaceholder: "sk-ant-…"
	};
}
//#endregion
//#region src/features/MembersList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$45 = {
	key: 0,
	class: "member-empty"
};
var _hoisted_2$39 = { class: "member-name" };
var _hoisted_3$34 = {
	key: 0,
	class: "member-tag"
};
var _hoisted_4$27 = {
	key: 1,
	class: "member-handle"
};
var EMPTY$9 = "No members match.";
//#endregion
//#region src/features/MembersList.vue
var MembersList_default = /* @__PURE__ */ defineComponent({
	__name: "MembersList",
	setup(__props) {
		/**
		* The room members list — third island.
		*
		* Mounted into <ul id="members-list">, exclusively owned by this module.
		*
		* Vue rendering rules established by the first two islands and applied here:
		*   - text that must match textContent exactly is BOUND, never written as
		*     template text (template text carries the surrounding newlines)
		*   - no comments in the template; Vue renders them as DOM comment nodes
		*   - v-bind an object for conditional attributes; :class emits class=""
		* This island needs none of the class exceptions — every class here is static.
		*/
		const sorted = computed(() => {
			const all = [...members.value].sort((a, b) => {
				if (a.identity_type !== b.identity_type) return a.identity_type === "agent" ? -1 : 1;
				return String(a.identity).localeCompare(String(b.identity));
			});
			const f = membersFilter.value;
			return f ? all.filter((m) => `${m.identity} ${m.handle || ""}`.toLowerCase().includes(f)) : all;
		});
		/** Matches the imperative label exactly, including the " (you)" suffix. */
		const label = (m) => m.identity === state.myIdentity ? `${m.identity} (you)` : m.identity;
		return (_ctx, _cache) => {
			return sorted.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$45, toDisplayString(EMPTY$9))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(sorted.value, (m) => {
				return openBlock(), createElementBlock("li", { key: m.identity }, [
					createElementVNode("span", { class: normalizeClass(`member-dot ${m.identity_type}`) }, null, 2),
					createElementVNode("span", _hoisted_2$39, toDisplayString(label(m)), 1),
					m.identity_type === "agent" ? (openBlock(), createElementBlock("span", _hoisted_3$34, "AGENT")) : m.handle ? (openBlock(), createElementBlock("span", _hoisted_4$27, "@" + toDisplayString(m.handle), 1)) : createCommentVNode("", true)
				]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/PermsUserList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$44 = {
	key: 0,
	class: "perms-empty"
};
var _hoisted_2$38 = {
	key: 1,
	class: "perms-empty",
	style: { "padding": "16px" }
};
var _hoisted_3$33 = ["onClick", "onKeydown"];
var _hoisted_4$26 = { class: "perms-user-name" };
var _hoisted_5$21 = { class: "perms-name-text" };
var _hoisted_6$17 = {
	key: 0,
	class: "perms-you-tag"
};
var _hoisted_7$13 = { class: "perms-user-id-sub" };
var _hoisted_8$10 = { class: "perms-user-summary" };
var NO_USERS = "No users yet — anyone who authenticates will appear here.";
var NO_MATCH$2 = "No users match.";
//#endregion
//#region src/features/PermsUserList.vue
var PermsUserList_default = /* @__PURE__ */ defineComponent({
	__name: "PermsUserList",
	props: { onSelect: { type: Function } },
	setup(__props) {
		/**
		* The permissions user list — eleventh island.
		*
		* Mounted into <ul id="perms-user-list">, exclusively owned by this module.
		*
		* Sorting and filtering stay HERE rather than being shaped at the mount site
		* like ModelList and SearchResults. Those two shape upstream because their row
		* data needs something the component must not have (a module cycle, an escaping
		* order). This one needs neither: the inputs are the raw user records plus two
		* scalars, and the derivations are pure. Keeping them in a computed means the
		* A–Z toggle and the search box re-sort by touching a ref, instead of by
		* calling a render function that rebuilds the DOM.
		*
		* Rendering rules from the earlier islands, all load-bearing here:
		*   - text is BOUND, never written as template text (template text carries the
		*     surrounding newlines, which textContent did not have)
		*   - no comments in the template; Vue renders them as DOM comment nodes
		*   - v-bind an object for a conditional class; :class="{active:false}" emits
		*     class="" where the imperative version had no class attribute at all
		*/
		const props = __props;
		const byName = (a, b) => userDisplayName(a).localeCompare(userDisplayName(b));
		/**
		* A–Z toggle: flat alphabetical when on; the tiered "auto" order when off —
		* you first, then owners, then admins, then everyone else, alpha within tier.
		*/
		const sorted = computed(() => permsSortAz.value ? [...permsUsers.value].sort(byName) : [...permsUsers.value].sort((a, b) => {
			const tier = (u) => u.id === permsMyUserId.value ? 0 : userIsOwner(u) ? 1 : userIsGlobalAdmin(u) || userScopedAdminCount(u) ? 2 : 3;
			const ta = tier(a);
			const tb = tier(b);
			return ta !== tb ? ta - tb : byName(a, b);
		}));
		/**
		* Match on display name AND the namespaced id, so you can find someone by
		* handle/email or by channel prefix (e.g. "slack:").
		*/
		const rows = computed(() => permsUserFilter.value ? sorted.value.filter((u) => `${userDisplayName(u)} ${u.id}`.toLowerCase().includes(permsUserFilter.value)) : sorted.value);
		const emptyText = computed(() => permsUsers.value.length === 0 ? NO_USERS : NO_MATCH$2);
		function activate(u) {
			props.onSelect(u.id);
		}
		/**
		* One keydown handler, not @keydown.enter plus @keydown.space. Two modifier
		* bindings on the same event compile to an array the invoker walks, which is
		* still a single addEventListener — but it is a detail of the compiler, and the
		* listener-set guard compares (id, type) pairs. Writing the original's single
		* handler keeps the comparison honest instead of relying on that.
		*/
		function onKey(e, u) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				activate(u);
			}
		}
		return (_ctx, _cache) => {
			return unref(usersError) ? (openBlock(), createElementBlock("li", _hoisted_1$44, toDisplayString(unref(usersError)), 1)) : rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_2$38, toDisplayString(emptyText.value), 1)) : (openBlock(true), createElementBlock(Fragment, { key: 2 }, renderList(rows.value, (u) => {
				return openBlock(), createElementBlock("li", mergeProps({
					key: u.id,
					tabindex: "0"
				}, { ref_for: true }, u.id === unref(permsSelectedUserId) ? { class: "active" } : {}, {
					onClick: ($event) => activate(u),
					onKeydown: ($event) => onKey($event, u)
				}), [
					createElementVNode("div", _hoisted_4$26, [createElementVNode("span", _hoisted_5$21, toDisplayString(unref(userDisplayName)(u)), 1), u.id === unref(permsMyUserId) ? (openBlock(), createElementBlock("span", _hoisted_6$17, "YOU")) : createCommentVNode("", true)]),
					createElementVNode("div", _hoisted_7$13, toDisplayString(u.id), 1),
					createElementVNode("div", _hoisted_8$10, toDisplayString(unref(userRoleSummary)(u)), 1)
				], 16, _hoisted_3$33);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/members.ts
var deps$19 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideMembersDeps(provided) {
	Object.assign(deps$19, provided);
}
function rememberServerAuthHint(methods) {
	if (!methods) return;
	state.serverUsesTailscale = !!methods.tailscale;
	try {
		localStorage.setItem("webchat-server-tailscale", state.serverUsesTailscale ? "1" : "0");
	} catch {}
}
async function updateUserCredsBanner(roomId) {
	const banner = $("#user-creds-banner");
	if (!banner || !roomId) return;
	const hideAll = () => {
		banner.hidden = true;
		userCredsState.value = null;
		userCredsConnected.value = false;
		updateHandleCreds();
		renderHandleChip();
	};
	try {
		const r = await authFetch(`/api/user-credentials/credential?roomId=${encodeURIComponent(roomId)}`);
		if (!r.ok) {
			hideAll();
			return;
		}
		const { connected, mode, oauthAllowed, apiKeyAllowed = true, provider = "claude" } = await r.json();
		userCredsProvider.value = provider;
		const { name, subWord, keyWord, keyPlaceholder } = userCredsWords(provider);
		const apiOffered = mode !== "disabled" && apiKeyAllowed;
		const oauthOffered = mode !== "disabled" && oauthAllowed;
		if (!apiOffered && !oauthOffered) {
			hideAll();
			return;
		}
		userCredsState.value = {
			offered: true,
			connected,
			provider,
			oauthAllowed: oauthOffered,
			apiOffered,
			subWord,
			keyWord
		};
		userCredsConnected.value = connected;
		updateHandleCreds();
		renderHandleChip();
		if (connected) {
			banner.hidden = true;
			return;
		}
		const connectBtn = $("#user-creds-connect-btn");
		const oauthBtn = $("#user-creds-oauth-btn");
		const input = $("#user-creds-key-input");
		banner.hidden = false;
		input.hidden = true;
		input.value = "";
		input.placeholder = keyPlaceholder;
		if (oauthBtn) {
			oauthBtn.hidden = !oauthOffered;
			oauthBtn.textContent = `Connect to ${name}`;
		}
		connectBtn.hidden = !apiOffered;
		if (connectBtn) connectBtn.textContent = "API key";
	} catch {
		hideAll();
	}
}
async function disconnectUserCreds() {
	const r = await authFetch("/api/user-credentials/credential", {
		method: "DELETE",
		headers: {
			"Content-Type": "application/json",
			"X-Webchat-CSRF": "1"
		},
		body: JSON.stringify({ roomId: state.currentRoom })
	});
	if (r.ok) {
		showToast("Disconnected your account.", { kind: "success" });
		await updateUserCredsBanner(state.currentRoom);
	} else showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
}
function closeUserCredsOauthModal() {
	if (userCredsOauthSessionId.value) {
		authFetch(userCredsOauthTarget.value === "workspace-codex" ? "/api/workspace-credential/codex/cancel" : userCredsOauthTarget.value === "workspace" ? "/api/workspace-credential/oauth/cancel" : userCredsProvider.value === "codex" ? "/api/user-credentials/codex/cancel" : "/api/user-credentials/oauth/cancel", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ sessionId: userCredsOauthSessionId.value })
		}).catch(() => {});
		userCredsOauthSessionId.value = null;
	}
	const modal = $("#user-creds-oauth-modal");
	if (modal) modal.hidden = true;
	if (userCredsOauthReturnFocus.value && typeof userCredsOauthReturnFocus.value.focus === "function") userCredsOauthReturnFocus.value.focus();
	userCredsOauthReturnFocus.value = null;
}
function renderMembers(members) {
	members.value = members;
	const toggle = $("#members-toggle");
	toggle.textContent = members.length;
	toggle.hidden = !state.currentRoom;
	paintMembersList();
}
var membersListApp = null;
/** Mount the MembersList island into <ul id="members-list">, once. */
function mountMembersList() {
	if (membersListApp) return;
	const host = $("#members-list");
	if (!host) return;
	membersListApp = createApp(MembersList_default);
	membersListApp.mount(host);
}
function paintMembersList() {
	mountMembersList();
}
function toggleMembersPanel() {
	const panel = $("#members-panel");
	const overlay = $("#members-overlay");
	const visible = panel.hidden;
	panel.hidden = !visible;
	if (visible) overlay.classList.add("visible");
	else overlay.classList.remove("visible");
}
var permsUserListApp = null;
function mountPermsUserList() {
	if (permsUserListApp) return;
	const host = $("#perms-user-list");
	if (!host) return;
	permsUserListApp = createApp(PermsUserList_default, { onSelect: permsSelectUser });
	permsUserListApp.mount(host);
}
/**
* Sync the island's inputs and mount it on first call.
*
* The sort and the filter are NOT applied here — the component derives both
* from these refs, so the A–Z toggle and the search box no longer need to call
* this function at all. It stays because refreshPermissions() calls it after
* fetching, which is a genuine data change.
*/
function renderPermsUserList() {
	permsSortAz.value = !!usersSortAz.value;
	usersError.value = "";
	mountPermsUserList();
}
/**
* Replace the user list with a failure message. Exported because the fetch that
* fails lives in perms.ts, while the element and its island are owned here —
* and the whole point of the usersError ref is that this module stays the only
* writer of that DOM.
*/
function showPermsUsersError(message) {
	usersError.value = message;
	mountPermsUserList();
}
function permsSelectUser(userId) {
	permsSelectedUserId.value = userId;
	deps$19.renderPermsDetail(userId);
	permsSelectedUserId.value = userId ?? null;
	deps$19.permsShowDetail();
}
async function deleteUser(targetUserId) {
	if (!await deps$19.showConfirmModal({
		title: "Delete user",
		body: `Delete ${targetUserId}? This removes the user record. They will be re-added automatically if they authenticate again.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		const r = await authFetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
			method: "DELETE",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!r.ok) {
			showToast("Delete failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		showToast(`Deleted user ${targetUserId}.`, { kind: "success" });
		permsSelectedUserId.value = null;
		await deps$19.refreshPermissions();
		deps$19.permsShowList();
	} catch (err) {
		showToast("Delete failed: " + err.message, { kind: "error" });
	}
}
function wireMembersPanel() {
	$("#handle-creds-action")?.addEventListener("click", async () => {
		if (!userCredsState.value) return;
		closeHandlePopover();
		if (userCredsState.value.connected) {
			if (await showConfirmModal({
				title: `Disconnect ${userCredsWords(userCredsState.value?.provider).name}?`,
				confirmLabel: "Disconnect",
				destructive: true
			})) await disconnectUserCreds();
		} else if (userCredsState.value.oauthAllowed) $("#user-creds-oauth-btn")?.click();
		else {
			const banner = $("#user-creds-banner");
			if (banner) {
				banner.hidden = false;
				banner.scrollIntoView({
					behavior: "smooth",
					block: "nearest"
				});
				banner.classList.add("user-creds-banner-flash");
				setTimeout(() => banner.classList.remove("user-creds-banner-flash"), 1200);
			}
			$("#user-creds-connect-btn")?.click();
		}
	});
	$("#user-creds-connect-btn")?.addEventListener("click", async (e) => {
		const input = $("#user-creds-key-input");
		if (!input) return;
		if (input.hidden) {
			input.hidden = false;
			input.focus();
			return;
		}
		const apiKey = input.value.trim();
		if (!apiKey) return;
		const btn = e.currentTarget;
		btn.disabled = true;
		try {
			const r = await authFetch("/api/user-credentials/credential", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify({
					roomId: state.currentRoom,
					apiKey
				})
			});
			if (r.ok) {
				showToast(`Connected your ${userCredsWords(userCredsProvider.value).keyWord}.`, { kind: "success" });
				await updateUserCredsBanner(state.currentRoom);
			} else showToast("Failed to connect key: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
		} catch (err) {
			showToast("Failed to connect key: " + (err?.message || "network error"), { kind: "error" });
		} finally {
			btn.disabled = false;
		}
	});
	$("#user-creds-key-input")?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") $("#user-creds-connect-btn")?.click();
	});
}
function wireMembersOauth1() {
	$("#user-creds-oauth-modal")?.addEventListener("click", (e) => {
		if (e.target === $("#user-creds-oauth-modal")) closeUserCredsOauthModal();
	});
	document.addEventListener("keydown", (e) => {
		const modal = $("#user-creds-oauth-modal");
		if (!modal || modal.hidden) return;
		if (e.key === "Escape") {
			e.preventDefault();
			closeUserCredsOauthModal();
			return;
		}
		if (e.key !== "Tab") return;
		const focusable = Array.from(modal.querySelectorAll("button:not([hidden]), a[href], input:not([hidden])")).filter((el) => el.offsetParent !== null && !el.disabled);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	});
}
function wireMembersOauth2() {
	$("#members-overlay")?.addEventListener("click", toggleMembersPanel);
}
function updateHandleCreds() {
	const wrap = $("#handle-creds");
	if (!wrap) return;
	if (!userCredsState.value || !userCredsState.value.offered) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	const statusEl = $("#handle-creds-status");
	const actionBtn = $("#handle-creds-action");
	const { name } = userCredsWords(userCredsState.value?.provider);
	if (statusEl) {
		statusEl.textContent = `${name} — ${userCredsState.value.connected ? "connected" : "not connected"}`;
		statusEl.classList.toggle("is-connected", !!userCredsState.value?.connected);
	}
	if (actionBtn) actionBtn.textContent = userCredsState.value.connected ? "Disconnect" : "Connect";
}
function renderHandleChip() {
	const chip = $("#handle-chip");
	if (!chip) return;
	const label = state.myHandle ? `@${state.myHandle}` : "+ set @handle";
	chip.textContent = userCredsConnected.value ? `🔑 ${label}` : label;
	chip.classList.toggle("is-unset", !state.myHandle);
	chip.classList.toggle("has-cred", userCredsConnected.value);
	chip.title = userCredsConnected.value ? "Billing your own account — click to manage" : "Edit your handle";
	chip.setAttribute("aria-label", userCredsConnected.value ? "Billing your own account — manage credentials" : "Edit your handle");
}
async function saveHandle() {
	const input = $("#handle-input");
	const status = $("#handle-status");
	if (!input || !status) return;
	const next = input.value.trim().toLowerCase().replace(/^@/, "");
	const showStatus = (text, ok) => {
		status.hidden = false;
		status.textContent = text;
		status.classList.toggle("ok", !!ok);
		status.classList.toggle("err", !ok);
	};
	if (!/^[a-z0-9-]{1,32}$/.test(next)) {
		showStatus("Use 1–32 letters, numbers, or hyphens.", false);
		return;
	}
	if (next === state.myHandle) {
		showStatus("That’s already your handle.", true);
		return;
	}
	try {
		const res = await authFetch("/api/me/handle", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ handle: next })
		});
		if (res.ok) {
			state.myHandle = (((await res.json()).handle || next) + "").toLowerCase();
			input.value = state.myHandle;
			renderHandleChip();
			showStatus("Saved.", true);
		} else if (res.status === 409) showStatus("That handle is taken.", false);
		else if (res.status === 400) showStatus("Use 1–32 letters, numbers, or hyphens.", false);
		else showStatus("Couldn’t save — try again.", false);
	} catch {
		showStatus("Couldn’t save — try again.", false);
	}
}
//#endregion
//#region src/features/agent-mcp-state.ts
var agentMcpRows = ref([]);
//#endregion
//#region src/features/AgentMcpList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$43 = { class: "agent-mcp-info" };
var _hoisted_2$37 = { class: "agent-mcp-name" };
var _hoisted_3$32 = { class: "agent-mcp-meta" };
var _hoisted_4$25 = [
	"aria-label",
	"innerHTML",
	"onClick"
];
//#endregion
//#region src/features/AgentMcpList.vue
var AgentMcpList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentMcpList",
	emits: ["detach"],
	setup(__props, { emit: __emit }) {
		/**
		* MCP servers attached to the open agent.
		*
		* Mounted into <ul id="agent-mcp-list">. The fetch and the count badge stay in
		* renderAgentMcp() — an island renders state, it does not own IO.
		*
		* The remove button's icon is an SVG string from lucide(), so it is bound with
		* v-html exactly as the imperative version assigned innerHTML.
		*/
		const emit = __emit;
		const xIcon = lucide("x");
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(agentMcpRows), (s) => {
				return openBlock(), createElementBlock("li", {
					key: s.id,
					class: "agent-mcp-row"
				}, [createElementVNode("div", _hoisted_1$43, [createElementVNode("span", _hoisted_2$37, toDisplayString(s.name), 1), createElementVNode("span", _hoisted_3$32, toDisplayString(s.transport) + " · " + toDisplayString(s.target), 1)]), createElementVNode("button", {
					type: "button",
					class: "agent-mcp-remove",
					"aria-label": `Detach ${s.name}`,
					innerHTML: unref(xIcon),
					onClick: ($event) => emit("detach", s)
				}, null, 8, _hoisted_4$25)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/McpList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$42 = {
	key: 0,
	style: {
		cursor: "default",
		opacity: .6
	}
};
var _hoisted_2$36 = [
	"data-mcp-id",
	"onClick",
	"onKeydown"
];
var _hoisted_3$31 = ["title"];
var _hoisted_4$24 = { class: "model-row-name" };
var _hoisted_5$20 = {
	key: 1,
	class: "model-row-uses"
};
var emptyMessage = "No MCP servers registered. Click \"+ New server\" to add one.";
//#endregion
//#region src/features/McpList.vue
var McpList_default = /* @__PURE__ */ defineComponent({
	__name: "McpList",
	emits: ["pick"],
	setup(__props, { emit: __emit }) {
		/**
		* The MCP server list — second Vue island.
		*
		* Mounted into <ul id="mcp-list">, which no other module writes to.
		*
		* Replicates makeRowActivatable() inline (role/tabindex, click, Enter/Space)
		* rather than calling it: that helper attaches listeners imperatively to a node
		* it is handed, which is the thing an island exists to stop doing. The
		* behaviour is identical — verified by diffing the rendered DOM.
		*
		* Vue rendering notes carried over from AgentList.vue, both re-checked here:
		*   - the active row uses v-bind of a whole object, not :class. Both
		*     :class="{ active: false }" and :class="undefined" emit class="" on every
		*     other row, because Vue normalises class to a string instead of omitting.
		*   - never write explanatory comments in the TEMPLATE; Vue renders them into
		*     the DOM as comment nodes.
		*/
		const emit = __emit;
		const sorted = computed(() => [...mcpServers.value].sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""))));
		/**
		* Bound as an expression, not written as template text. Text on its own line in
		* a template renders with the surrounding whitespace, which the imperative
		* textContent assignment never produced — caught by the rendered-DOM diff.
		*/
		function healthTitle(h) {
			if (h.status === "ok") return `Healthy — ${h.toolCount ?? "?"} tools`;
			if (h.status === "drift") return "Tool surface changed since approval";
			if (h.status === "auth") return "Rejecting credentials";
			return `Unreachable${h.reason ? `: ${h.reason}` : ""}`;
		}
		return (_ctx, _cache) => {
			return sorted.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$42, toDisplayString(emptyMessage))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(sorted.value, (server) => {
				return openBlock(), createElementBlock("li", mergeProps({
					key: server.id,
					"data-mcp-id": server.id
				}, { ref_for: true }, server.id === unref(selectedMcpId) ? { class: "active" } : {}, {
					role: "button",
					tabindex: "0",
					onClick: ($event) => emit("pick", server.id),
					onKeydown: [withKeys(withModifiers(($event) => emit("pick", server.id), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => emit("pick", server.id), ["prevent"]), ["space"])]
				}), [
					createElementVNode("span", { class: normalizeClass(`model-kind-badge kind-${server.transport}`) }, toDisplayString(server.transport), 3),
					server.health && server.transport !== "stdio" ? (openBlock(), createElementBlock("span", {
						key: 0,
						class: normalizeClass(`mcp-health-dot mcp-health-${server.health.status}`),
						title: healthTitle(server.health)
					}, null, 10, _hoisted_3$31)) : createCommentVNode("", true),
					createElementVNode("span", _hoisted_4$24, toDisplayString(server.name), 1),
					server.agents_assigned > 0 ? (openBlock(), createElementBlock("span", _hoisted_5$20, toDisplayString(server.agents_assigned) + "×", 1)) : createCommentVNode("", true)
				], 16, _hoisted_2$36);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/origin-badge.ts
/**
* Stable hue per label, so a publisher keeps its colour across renders.
*
* The 60–190 band is excluded, not wrapped around: those are the yellows and
* greens that read as "warning" and "success" elsewhere in the console, and a
* publisher name is neither. Copied exactly — a plain `% 360` would look right
* and quietly recolour every badge.
*/
function labelHue(str) {
	const BAND_LO = 60;
	const usable = 230;
	let h = 0;
	for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % usable;
	return h < BAND_LO ? h : h + 130;
}
/**
* Everything the badge renders, decided once.
*
* Only http(s) — never let a javascript:/data: URL become a click-XSS sink
* (defense-in-depth; the source list is owner-gated config).
*/
function originBadgeProps(origin) {
	const safeUrl = /^https?:\/\//i.test(origin.url || "") ? origin.url : null;
	return {
		tag: safeUrl ? "a" : "span",
		className: "skill-badge skill-badge-origin" + (origin.official ? " skill-badge-official" : ""),
		label: origin.label,
		hue: origin.official ? null : String(labelHue(origin.label)),
		href: safeUrl,
		title: safeUrl ? `${origin.label} — open source ↗` : null
	};
}
//#endregion
//#region src/features/OriginBadge.vue
var OriginBadge_default = /* @__PURE__ */ defineComponent({
	__name: "OriginBadge",
	props: { origin: {} },
	setup(__props) {
		/**
		* The provenance pill — where a skill or MCP server comes from.
		*
		* Not an island: it has no mount point of its own. It is the declarative half
		* of origin-badge.ts, used by islands that render rows containing a badge,
		* while the still-imperative call sites keep using originBadgeEl().
		*
		* Every decision — element type, classes, hue, and the http(s) test that keeps
		* a javascript:/data: URL out of an href — comes from originBadgeProps(). This
		* component makes none of them. That is the whole point of the split: writing
		* the conditionals again here would put a second copy of a security check in
		* the codebase, and the copy that drifts is the one that stops checking.
		*
		* The click handler stops propagation because the rows that carry a badge are
		* themselves clickable (they open an editor), matching the imperative version.
		*/
		const props = __props;
		const p = computed(() => originBadgeProps(props.origin));
		/**
		* Built as one object so absent values emit NO attribute rather than an empty
		* one. :href="null" removes it, but --badge-hue via :style would still emit
		* style="", which is the class of difference the first island was caught on.
		*/
		const attrs = computed(() => {
			const v = p.value;
			const out = { class: v.className };
			if (v.hue !== null) out.style = { "--badge-hue": v.hue };
			if (v.href) {
				out.href = v.href;
				out.target = "_blank";
				out.rel = "noopener noreferrer";
				out.title = v.title;
				out.onClick = (e) => e.stopPropagation();
			}
			return out;
		});
		return (_ctx, _cache) => {
			return openBlock(), createBlock(resolveDynamicComponent(p.value.tag), normalizeProps(guardReactiveProps(attrs.value)), {
				default: withCtx(() => [createTextVNode(toDisplayString(p.value.label), 1)]),
				_: 1
			}, 16);
		};
	}
});
//#endregion
//#region src/features/mcp-panel-state.ts
/** /api/mcp-sources rows — the built-in registry entries and their on/off state. */
var mcpSources = ref([]);
/** The tools a probed server advertises. Empty is a rendered state, not absence. */
var probeTools = ref([]);
/** The selected server, as the hardening panel renders it. Null hides everything. */
var hardeningServer = ref(null);
/** true while the OAuth connect request is in flight. */
var oauthBusy = ref(false);
/** Catalog rows, already shaped. Empty with phase 'ready' means no matches. */
var mcpCatalog = ref([]);
/** 'loading' | 'error' | 'ready' — 'error' clears the list and shows a status. */
var mcpCatalogPhase = ref("loading");
/** Drives the wait row's wording: searching vs first load. */
var mcpCatalogQuery = ref("");
//#endregion
//#region src/features/McpSources.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$41 = { class: "skill-info" };
var _hoisted_2$35 = { class: "skill-head" };
var _hoisted_3$30 = { class: "skill-desc" };
var _hoisted_4$23 = ["onClick"];
var BUILT_IN$1 = "built-in";
var REMOVED_NOTE = "Removed from Add MCP server";
//#endregion
//#region src/features/McpSources.vue
var McpSources_default = /* @__PURE__ */ defineComponent({
	__name: "McpSources",
	props: { onToggle: { type: Function } },
	setup(__props) {
		/**
		* The MCP registry source list — nineteenth island.
		*
		* Mounted into <ul id="mcp-sources-list">, exclusively owned by this module.
		*
		* #mcp-sources (the section's hidden flag, which also encodes "not a
		* global admin") is outside the mount point and stays imperative.
		*
		* First island to render an OriginBadge. The badge is a component rather than
		* a v-html of originBadgeEl's output precisely because it carries an href
		* decision — see the note in origin-badge.ts.
		*
		* Same row idiom as the skill collections' built-in source: info column (name +
		* meta), a built-in badge, and a reversible Remove/Add — no standing prose, no
		* confirm, since adding it back is one click.
		*/
		const props = __props;
		const rows = computed(() => mcpSources.value.map((src) => {
			const off = !!(src.removed || src.disabled);
			return {
				id: src.id,
				off,
				origin: {
					label: "MCP registry",
					url: src.url,
					official: false
				},
				meta: off ? REMOVED_NOTE : String(src.url).replace(/^https?:\/\//, ""),
				toggleClass: off ? "btn btn-ghost" : "skill-delete",
				toggleLabel: off ? "Add" : "Remove"
			};
		}));
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.id,
					class: normalizeClass(r.off ? "skill-source-row source-disabled" : "skill-source-row")
				}, [
					createElementVNode("div", _hoisted_1$41, [createElementVNode("div", _hoisted_2$35, [createVNode(OriginBadge_default, { origin: r.origin }, null, 8, ["origin"])]), createElementVNode("span", _hoisted_3$30, toDisplayString(r.meta), 1)]),
					createElementVNode("span", { class: "skill-badge" }, toDisplayString(BUILT_IN$1)),
					createElementVNode("button", {
						type: "button",
						class: normalizeClass(r.toggleClass),
						onClick: ($event) => props.onToggle(r.id, r.off)
					}, toDisplayString(r.toggleLabel), 11, _hoisted_4$23)
				], 2);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/McpProbeTools.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$40 = {
	key: 0,
	class: "empty-note"
};
var EMPTY$8 = "Connected, but the server advertises no tools.";
//#endregion
//#region src/features/McpProbeTools.vue
var McpProbeTools_default = /* @__PURE__ */ defineComponent({
	__name: "McpProbeTools",
	setup(__props) {
		/**
		* The tools a probed MCP server advertises — twentieth island.
		*
		* Mounted into <ul id="mcp-probe-tools">, exclusively owned by this module.
		*
		* The probe's other outputs — #mcp-probe-kind, #mcp-probe-notes, the suggested
		* name in #mcp-probe-name and the #mcp-probe-results hidden flag — are all
		* outside the mount point and stay imperative.
		*
		* The description keeps its inline opacity. It is presentational and belongs in
		* style.css, but moving it would be a CSS change riding along in a conversion
		* commit, and this phase does not do that.
		*/
		const DIM = { opacity: "0.75" };
		const rows = computed(() => probeTools.value.map((t, i) => ({
			key: `${i}:${t.name}`,
			name: t.name,
			desc: t.description ? ` — ${t.description}` : ""
		})));
		return (_ctx, _cache) => {
			return rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$40, toDisplayString(EMPTY$8))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", { key: r.key }, [createElementVNode("b", null, toDisplayString(r.name), 1), r.desc ? (openBlock(), createElementBlock("span", {
					key: 0,
					style: DIM
				}, toDisplayString(r.desc), 1)) : createCommentVNode("", true)]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/McpHardening.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$39 = {
	key: 1,
	class: "mcp-drift-banner"
};
var _hoisted_2$34 = { key: 2 };
var _hoisted_3$29 = { class: "form-label" };
var _hoisted_4$22 = { class: "mcp-tools-list" };
var _hoisted_5$19 = ["checked", "data-tool"];
var _hoisted_6$16 = ["title"];
var _hoisted_7$12 = ["disabled"];
var _hoisted_8$9 = {
	key: 3,
	class: "room-prime-note"
};
var DRIFT_HEAD = "Tools changed since you approved this server";
var APPROVE = "Review + re-approve";
var SAVE_TOOLS = "Save tool selection";
//#endregion
//#region src/features/McpHardening.vue
var McpHardening_default = /* @__PURE__ */ defineComponent({
	__name: "McpHardening",
	props: {
		onApprove: { type: Function },
		onSaveTools: { type: Function },
		onOauth: { type: Function }
	},
	setup(__props) {
		/**
		* An MCP server's hardening panel — thirty-fifth island.
		*
		* Mounted into <div id="mcp-hardening">, exclusively owned by this module.
		*
		* Four independent blocks, each conditional, rendered in a fixed order: health,
		* drift, the tool allowlist, then OAuth. stdio servers render nothing at all —
		* there is no transport to harden.
		*
		* The tool checkboxes keep their state in the DOM. Save reads them back with
		* querySelectorAll and compares the checked COUNT to the total, because "all
		* checked" is stored as null — no restriction, so future tools flow through
		* automatically. Modelling the ticks as state would mean that comparison reads
		* a ref instead, and getting it subtly wrong silently pins the surface.
		*/
		const props = __props;
		const BOLD = { fontWeight: "600" };
		const s = computed(() => hardeningServer.value);
		const show = computed(() => !!s.value && s.value.transport !== "stdio");
		const healthText = computed(() => {
			const h = s.value?.health;
			if (!h) return "";
			const when = h.at ? new Date(h.at).toLocaleString() : "";
			if (h.status === "ok") return `● Healthy — ${h.toolCount ?? "?"} tools (checked ${when})`;
			if (h.status === "auth") return `● Rejecting credentials (checked ${when})`;
			if (h.status === "down") return `● Unreachable (checked ${when})`;
			return `● Tool surface changed (checked ${when})`;
		});
		/** The drift summary, in the order the original built it. */
		const driftParts = computed(() => {
			const d = s.value?.drift;
			if (!d) return [];
			const parts = [];
			if (d.added?.length) parts.push(`new: ${d.added.join(", ")}`);
			if (d.removed?.length) parts.push(`removed: ${d.removed.join(", ")}`);
			if (d.changed?.length) parts.push(`descriptions changed: ${d.changed.join(", ")}`);
			return parts;
		});
		const tools = computed(() => {
			const p = s.value?.pinned_tools;
			if (!Array.isArray(p) || !p.length) return null;
			const enabled = Array.isArray(s.value.enabled_tools) ? new Set(s.value.enabled_tools) : null;
			return p.map((t) => ({
				name: t.name,
				desc: t.description || "",
				checked: enabled ? enabled.has(t.name) : true
			}));
		});
		const oauthLabel = computed(() => s.value?.auth?.kind === "oauth" ? "Reconnect (OAuth)" : "Connect with OAuth…");
		const authNote = computed(() => s.value?.auth?.kind === "oauth" ? "Connected via OAuth — the token lives on the host; agents go through the relay." : "Bearer token stored on the host — agents go through the relay, the token never enters a container.");
		return (_ctx, _cache) => {
			return show.value ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [
				s.value.health ? (openBlock(), createElementBlock("p", {
					key: 0,
					class: normalizeClass(`room-prime-note mcp-health-text-${s.value.health.status}`)
				}, toDisplayString(healthText.value), 3)) : createCommentVNode("", true),
				s.value.drift ? (openBlock(), createElementBlock("div", _hoisted_1$39, [
					createElementVNode("div", { style: BOLD }, toDisplayString(DRIFT_HEAD)),
					createElementVNode("div", null, toDisplayString(driftParts.value.join(" · ")), 1),
					createElementVNode("button", {
						type: "button",
						class: "btn btn-secondary",
						onClick: _cache[0] || (_cache[0] = ($event) => props.onApprove())
					}, toDisplayString(APPROVE))
				])) : createCommentVNode("", true),
				tools.value ? (openBlock(), createElementBlock("div", _hoisted_2$34, [
					createElementVNode("span", _hoisted_3$29, "Tools (" + toDisplayString(tools.value.length) + ")", 1),
					createElementVNode("div", _hoisted_4$22, [(openBlock(true), createElementBlock(Fragment, null, renderList(tools.value, (t) => {
						return openBlock(), createElementBlock("label", {
							key: t.name,
							class: "mcp-tool-row"
						}, [createElementVNode("input", {
							type: "checkbox",
							checked: t.checked,
							"data-tool": t.name
						}, null, 8, _hoisted_5$19), createElementVNode("span", { title: t.desc }, toDisplayString(t.name), 9, _hoisted_6$16)]);
					}), 128))]),
					createElementVNode("button", {
						type: "button",
						class: "btn btn-secondary",
						onClick: _cache[1] || (_cache[1] = ($event) => props.onSaveTools())
					}, toDisplayString(SAVE_TOOLS))
				])) : createCommentVNode("", true),
				createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost",
					disabled: unref(oauthBusy) || void 0,
					onClick: _cache[2] || (_cache[2] = ($event) => props.onOauth())
				}, toDisplayString(oauthLabel.value), 9, _hoisted_7$12),
				s.value.auth ? (openBlock(), createElementBlock("p", _hoisted_8$9, toDisplayString(authNote.value), 1)) : createCommentVNode("", true)
			], 64)) : createCommentVNode("", true);
		};
	}
});
//#endregion
//#region src/features/McpCatalog.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$38 = {
	key: 0,
	class: "skills-empty"
};
var _hoisted_2$33 = { class: "mcp-catalog-head" };
var _hoisted_3$28 = { class: "mcp-catalog-title" };
var _hoisted_4$21 = { class: "mcp-catalog-desc" };
var _hoisted_5$18 = { class: "mcp-catalog-target" };
var _hoisted_6$15 = { class: "mcp-catalog-actions" };
var _hoisted_7$11 = ["onClick"];
var USE = "Use";
//#endregion
//#region src/features/McpCatalog.vue
var McpCatalog_default = /* @__PURE__ */ defineComponent({
	__name: "McpCatalog",
	props: { onUse: { type: Function } },
	setup(__props) {
		/**
		* The MCP marketplace catalog — forty-sixth island.
		*
		* Mounted into <ul id="mcp-catalog-list">, exclusively owned by this module.
		* #mcp-catalog-status is outside it and stays imperative — it carries the
		* result count AND the fetch error, which are section-level, not row-level.
		*
		* The wait row is written out rather than v-html'd from loadingRow(): that
		* helper returns the <li> itself, so binding it would nest one. Same call made
		* for SkillPool, same DESIGN.md §5 wait primitive, and the DOM diff is what
		* holds the two to it.
		*
		* The 'error' phase renders NOTHING — the imperative version cleared the list
		* and put the message in the status line, so an empty list plus status text is
		* the correct shape, not an inline error row.
		*/
		const props = __props;
		const waitLabel = computed(() => mcpCatalogQuery.value ? "Searching…" : "Loading catalog…");
		return (_ctx, _cache) => {
			return unref(mcpCatalogPhase) === "loading" ? (openBlock(), createElementBlock("li", _hoisted_1$38, [_cache[0] || (_cache[0] = createElementVNode("span", {
				class: "btn-spinner",
				"aria-hidden": "true"
			}, null, -1)), createTextVNode(toDisplayString(waitLabel.value), 1)])) : unref(mcpCatalogPhase) === "ready" ? (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(mcpCatalog), (s, i) => {
				return openBlock(), createElementBlock("li", {
					key: i,
					class: "mcp-catalog-row"
				}, [
					createElementVNode("div", _hoisted_2$33, [
						createElementVNode("span", _hoisted_3$28, toDisplayString(s.title), 1),
						s.origin ? (openBlock(), createBlock(OriginBadge_default, {
							key: 0,
							origin: s.origin
						}, null, 8, ["origin"])) : createCommentVNode("", true),
						createElementVNode("span", { class: normalizeClass(s.kindClass) }, toDisplayString(s.kindText), 3)
					]),
					createElementVNode("div", _hoisted_4$21, toDisplayString(s.desc), 1),
					createElementVNode("div", _hoisted_5$18, toDisplayString(s.target), 1),
					createElementVNode("div", _hoisted_6$15, [createElementVNode("button", {
						type: "button",
						class: "btn btn-secondary",
						onClick: ($event) => props.onUse(s.raw)
					}, toDisplayString(USE), 8, _hoisted_7$11)])
				]);
			}), 128)) : createCommentVNode("", true);
		};
	}
});
//#endregion
//#region src/features/mcp.ts
var deps$18 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideMcpDeps(provided) {
	Object.assign(deps$18, provided);
}
var agentMcpApp = null;
function mountAgentMcpList(agentId) {
	if (agentMcpApp) return;
	const host = $("#agent-mcp-list");
	if (!host) return;
	agentMcpApp = createApp(AgentMcpList_default, { onDetach: (s) => detachAgentMcp(currentAgentMcpId, s) });
	agentMcpApp.mount(host);
}
var currentAgentMcpId = null;
async function renderAgentMcp(agentId) {
	currentAgentMcpId = agentId;
	agentMcpServers.value = [];
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`);
		if (res.ok) agentMcpServers.value = (await res.json()).servers || [];
	} catch (err) {
		console.error("Failed to load MCP servers:", err);
	}
	const rows = agentMcpServers.value ?? [];
	const mcpCount = $("#agent-mcp-count");
	if (mcpCount) mcpCount.textContent = rows.length ? String(rows.length) : "";
	agentMcpRows.value = rows;
	mountAgentMcpList(agentId);
}
async function setAgentMcp(agentId, body, okMsg) {
	await apiJson(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`, {
		method: "PUT",
		body
	});
	showToast(okMsg, { kind: "success" });
	await renderAgentMcp(agentId);
}
async function detachAgentMcp(agentId, server) {
	if (!await deps$18.showConfirmModal({
		title: `Detach ${server.name}?`,
		body: "The agent loses these tools on its next message.",
		confirmLabel: "Detach",
		destructive: true
	})) return;
	try {
		await setAgentMcp(agentId, { remove: [server.id] }, `Detached ${server.name}`);
	} catch (err) {
		showToast("Detach failed: " + (err.message || err), { kind: "error" });
	}
}
async function maybeAttachAfterMcpAdd(newId, name) {
	if (!mcpAddInProgress.value) return;
	const agentId = mcpAgentForAdd.value;
	mcpAddInProgress.value = false;
	mcpAgentForAdd.value = null;
	if (!agentId || !newId) return;
	try {
		await setAgentMcp(agentId, { add: [newId] }, `Attached ${name}`);
	} catch (err) {
		showToast("Attach failed: " + (err.message || err), { kind: "error" });
	}
	await deps$18.openAgentDetail(agentId);
}
async function fetchMcpServers() {
	try {
		const res = await authFetch("/api/mcp-servers");
		const body = res.ok ? await res.json().catch(() => null) : null;
		if (!Array.isArray(body)) {
			allMcpServers.value = [];
			renderMcpServers();
			if (!res.ok) console.error("Failed to fetch MCP servers:", res.status, res.statusText);
			return;
		}
		allMcpServers.value = body;
		renderMcpServers();
	} catch (err) {
		console.error("Failed to fetch MCP servers:", err);
	}
}
var mcpRegistryDisabled = false;
async function renderMcpSources() {
	const list = $("#mcp-sources-list");
	const section = $("#mcp-sources");
	if (!list || !section) return;
	let sources = [];
	try {
		const res = await authFetch("/api/mcp-sources");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		sources = (await res.json()).sources || [];
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	for (const src of sources) mcpRegistryDisabled = !!(src.removed || src.disabled);
	mcpSources.value = sources;
	mountMcpSources();
	applyMcpCatalogVisibility();
}
var mcpSourcesApp = null;
function mountMcpSources() {
	if (mcpSourcesApp) return;
	const host = $("#mcp-sources-list");
	if (!host) return;
	mcpSourcesApp = createApp(McpSources_default, { onToggle: async (id, off) => {
		try {
			const res = await authFetch(`/api/mcp-sources/${encodeURIComponent(id)}`, { method: off ? "POST" : "DELETE" });
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
			renderMcpSources();
			applyMcpCatalogVisibility();
		} catch (err) {
			toastError(err, "Could not update the source");
		}
	} });
	mcpSourcesApp.mount(host);
}
function applyMcpCatalogVisibility() {
	const block = $("#mcp-catalog-block");
	if (block) block.hidden = mcpRegistryDisabled;
}
var mcpCatalogApp = null;
function mountMcpCatalog() {
	if (mcpCatalogApp) return;
	const host = $("#mcp-catalog-list");
	if (!host) return;
	mcpCatalogApp = createApp(McpCatalog_default, { onUse: (raw) => useMcpCatalogEntry(raw) });
	mcpCatalogApp.mount(host);
}
async function loadMcpCatalog(q = "") {
	if (!$("#mcp-catalog-list")) return;
	const status = $("#mcp-catalog-status");
	mcpCatalogQuery.value = q;
	mcpCatalogPhase.value = "loading";
	mountMcpCatalog();
	status.textContent = "";
	let servers = [];
	try {
		const payload = await apiJson(`/api/mcp-catalog${q ? `?q=${encodeURIComponent(q)}` : ""}`);
		if (payload.disabled) {
			mcpRegistryDisabled = true;
			applyMcpCatalogVisibility();
			return;
		}
		servers = payload.servers || [];
	} catch (err) {
		mcpCatalog.value = [];
		mcpCatalogPhase.value = "error";
		status.textContent = err.message || "Couldn't reach the registry";
		return;
	}
	status.textContent = servers.length ? `${servers.length} servers` : "No servers matched";
	mcpCatalog.value = servers.map((s) => ({
		raw: s,
		title: s.title || s.name,
		origin: s.publisher ? {
			label: s.publisher,
			official: false,
			url: s.repoUrl || s.websiteUrl || ""
		} : null,
		kindClass: s.runsCode ? "mcp-kind mcp-kind-code" : "mcp-kind",
		kindText: s.runsCode ? `${s.command === "uvx" ? "pypi" : "npm"} · runs in container` : "remote",
		desc: s.description || "",
		target: s.runsCode ? `${s.command} ${(s.args || []).join(" ")}` : s.url ? (() => {
			try {
				return `connects to ${new URL(s.url).host}`;
			} catch {
				return `connects to ${s.url}`;
			}
		})() : ""
	}));
	mcpCatalogPhase.value = "ready";
}
async function useMcpCatalogEntry(s) {
	if (s.runsCode) {
		const cmd = `${s.command} ${(s.args || []).join(" ")}`;
		if (!await deps$18.showConfirmModal({
			title: `Run ${s.name} in your container?`,
			body: `This isn't a hosted server. It runs code inside your agent container, alongside the agent's credentials:\n\n${cmd}\n\nOnly continue if you trust the publisher (${s.publisher || "unknown"}).`,
			confirmLabel: "I trust it — fill in the form",
			destructive: true
		})) return;
	}
	const shortName = String(s.name).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	$("#mcp-create-name").value = shortName;
	const transport = $("#mcp-create-transport");
	if (s.kind === "remote") {
		transport.value = s.transport === "sse" ? "sse" : "http";
		transport.dispatchEvent(new Event("change"));
		$("#mcp-create-url").value = s.url || "";
		const probeUrl = $("#mcp-probe-url");
		if (probeUrl) probeUrl.value = s.url || "";
	} else {
		transport.value = "stdio";
		transport.dispatchEvent(new Event("change"));
		$("#mcp-create-command").value = s.command || "";
		$("#mcp-create-args").value = (s.args || []).join(" ");
	}
	const block = $("#mcp-catalog-block");
	if (block) block.open = false;
	showToast(s.kind === "remote" ? `Filled in ${shortName} — probe it, then add` : `Filled in ${shortName} — review the command, then add`);
	$("#mcp-create-name").scrollIntoView({
		behavior: "smooth",
		block: "center"
	});
}
var mcpListApp = null;
/** Mount the McpList island into <ul id="mcp-list">, once. */
function mountMcpList() {
	if (mcpListApp) return;
	const host = $("#mcp-list");
	if (!host) return;
	mcpListApp = createApp(McpList_default, { onPick: (id) => {
		const detail = $("#mcp-detail");
		if (selectedMcpId.value === id && detail && !detail.hidden) closeMcpDetail();
		else openMcpDetail(id);
	} });
	mcpListApp.mount(host);
}
function renderMcpServers() {
	mcpServers.value = allMcpServers.value ?? [];
	mountMcpList();
}
function openMcpDetail(id) {
	const server = allMcpServers.value.find((s) => s.id === id);
	if (!server) return;
	deps$18.closeAgentDetail();
	deps$18.closeRoomDetail();
	deps$18.closeModelDetail();
	closeMcpDetail();
	selectedMcpId.value = id;
	renderMcpServers();
	$("#mcp-edit-view").hidden = false;
	$("#mcp-create-view").hidden = true;
	$("#mcp-detail-title").textContent = server.name;
	$("#mcp-name").value = server.name;
	$("#mcp-transport").value = server.transport;
	const remote = server.transport !== "stdio";
	$("#mcp-url-label").hidden = !remote;
	$("#mcp-command-label").hidden = remote;
	$("#mcp-token-label").hidden = !remote;
	$("#mcp-token").value = "";
	if (remote) $("#mcp-url").value = server.target;
	else $("#mcp-command").value = server.target;
	const usage = $("#mcp-detail-usage");
	usage.textContent = server.agents_assigned > 0 ? `Attached to ${server.agents_assigned} agent${server.agents_assigned === 1 ? "" : "s"}.` : "Not attached to any agent yet.";
	renderMcpHardening(server);
	$("#mcp-detail").hidden = false;
	$("#members-panel").hidden = true;
}
var hardeningApp = null;
function mountMcpHardening() {
	if (hardeningApp) return;
	const host = $("#mcp-hardening");
	if (!host) return;
	hardeningApp = createApp(McpHardening_default, {
		onApprove: async () => {
			const server = hardeningServer.value;
			const d = server?.drift;
			const parts = [];
			if (d?.added?.length) parts.push(`new: ${d.added.join(", ")}`);
			if (d?.removed?.length) parts.push(`removed: ${d.removed.join(", ")}`);
			if (d?.changed?.length) parts.push(`descriptions changed: ${d.changed.join(", ")}`);
			if (!await deps$18.showConfirmModal({
				title: `Approve ${server.name}'s new tools?`,
				body: parts.join("\n") || "The tool surface changed.",
				confirmLabel: "Approve current tools"
			})) return;
			try {
				await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/repin`, { method: "POST" });
				showToast("Tool surface re-approved", { kind: "success" });
				await fetchMcpServers();
				openMcpDetail(server.id);
			} catch (err) {
				showToast("Re-approve failed: " + (err.message || err), { kind: "error" });
			}
		},
		onSaveTools: async () => {
			const server = hardeningServer.value;
			const listEl = $("#mcp-hardening .mcp-tools-list");
			if (!server || !listEl) return;
			const boxes = [...listEl.querySelectorAll("input[type=checkbox]")];
			const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.tool);
			const body = { enabled: chosen.length === boxes.length ? null : chosen };
			try {
				await apiJson(`/api/mcp-servers/${encodeURIComponent(server.id)}/tools`, {
					method: "PUT",
					body
				});
				showToast(body.enabled ? `${chosen.length} of ${boxes.length} tools enabled` : "All tools enabled", { kind: "success" });
				await fetchMcpServers();
			} catch (err) {
				showToast("Save failed: " + (err.message || err), { kind: "error" });
			}
		},
		onOauth: async () => {
			const server = hardeningServer.value;
			if (!server) return;
			oauthBusy.value = true;
			try {
				const res = await authFetch(`/api/mcp-servers/${encodeURIComponent(server.id)}/oauth/start`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}"
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.error || res.statusText);
				if (!/^https?:\/\//i.test(body.authorizeUrl || "")) throw new Error("Server returned an invalid authorization URL");
				window.open(body.authorizeUrl, "_blank", "noopener");
				showToast("Finish authorizing in the new tab, then come back", { kind: "info" });
			} catch (err) {
				showToast("OAuth failed: " + (err.message || err), { kind: "error" });
			} finally {
				oauthBusy.value = false;
			}
		}
	});
	hardeningApp.mount(host);
}
function renderMcpHardening(server) {
	if (!$("#mcp-hardening")) return;
	hardeningServer.value = server ?? null;
	mountMcpHardening();
}
function closeMcpDetail() {
	$("#mcp-detail").hidden = true;
	$("#mcp-edit-view").hidden = false;
	$("#mcp-create-view").hidden = true;
	selectedMcpId.value = null;
	if (manageActive.value && manageTab.value === "mcp") renderMcpServers();
}
function syncMcpCreateTransportFields() {
	const remote = $("#mcp-create-transport").value !== "stdio";
	$("#mcp-create-token-label").hidden = !remote;
	$("#mcp-create-url-label").hidden = !remote;
	$("#mcp-create-command-label").hidden = remote;
	$("#mcp-create-args-label").hidden = remote;
}
function mcpProbeAuthHeaders() {
	const token = $("#mcp-probe-token").value.trim();
	return token ? { Authorization: `Bearer ${token}` } : void 0;
}
async function runMcpProbe() {
	const url = $("#mcp-probe-url").value.trim();
	if (!url) {
		showToast("Enter a server URL first (e.g. host:8000/sse).", { kind: "error" });
		return;
	}
	if (/\s|[<>]/.test(url)) {
		showToast("URL contains invalid characters.", { kind: "error" });
		return;
	}
	const status = $("#mcp-probe-status");
	const results = $("#mcp-probe-results");
	status.classList.remove("error");
	status.textContent = "Probing… (connects to the server and lists its tools)";
	status.hidden = false;
	results.hidden = true;
	$("#mcp-probe-btn").disabled = true;
	try {
		const headers = mcpProbeAuthHeaders();
		const res = await authFetch("/api/mcp-servers/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(headers ? {
				url,
				headers
			} : { url })
		});
		const body = await res.json();
		if (!res.ok) {
			status.textContent = body.error || `Probe failed (${res.status})`;
			status.classList.add("error");
			return;
		}
		if (!body.transport) {
			if (body.requiresAuth) {
				const tokenLabel = $("#mcp-probe-token-label");
				const hadToken = Boolean(headers);
				tokenLabel.hidden = false;
				status.textContent = hadToken ? "The server rejected that token — check it and probe again." : "This server requires a bearer token — enter it below and probe again.";
				status.classList.add("error");
				$("#mcp-probe-token").focus();
				return;
			}
			status.textContent = body.reason || "No MCP server responded.";
			status.classList.add("error");
			return;
		}
		lastMcpProbe.value = body;
		lastMcpProbeToken.value = $("#mcp-probe-token").value.trim();
		status.hidden = true;
		renderMcpProbeResults(body);
	} catch (err) {
		status.textContent = "Probe failed: " + err.message;
		status.classList.add("error");
	} finally {
		$("#mcp-probe-btn").disabled = false;
	}
}
var mcpProbeToolsApp = null;
function mountMcpProbeTools() {
	if (mcpProbeToolsApp) return;
	const host = $("#mcp-probe-tools");
	if (!host) return;
	mcpProbeToolsApp = createApp(McpProbeTools_default);
	mcpProbeToolsApp.mount(host);
}
function renderMcpProbeResults(probe) {
	$("#mcp-probe-kind").className = `model-probe-kind kind-${probe.transport}`;
	$("#mcp-probe-kind").textContent = probe.transport;
	const n = probe.tools.length;
	$("#mcp-probe-notes").textContent = `${probe.serverName || "MCP server"}${probe.serverVersion ? " v" + probe.serverVersion : ""} — ${n} tool${n === 1 ? "" : "s"}`;
	probeTools.value = probe.tools ?? [];
	mountMcpProbeTools();
	if (!$("#mcp-probe-name").value && probe.serverName) $("#mcp-probe-name").value = probe.serverName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	$("#mcp-probe-results").hidden = false;
}
async function createMcpServer(body, btn) {
	btn.disabled = true;
	try {
		const created = await apiJson("/api/mcp-servers", {
			method: "POST",
			body
		});
		showToast(`Added ${body.name}`, { kind: "success" });
		closeMcpDetail();
		await fetchMcpServers();
		await maybeAttachAfterMcpAdd(created.id || allMcpServers.value.find((s) => s.name === body.name)?.id, body.name);
	} catch (err) {
		showToast("Add failed: " + (err.message || err), { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
var mcpCatalogTimer;
function wireMcpPanel() {
	$("#mcp-probe-btn")?.addEventListener("click", runMcpProbe);
	$("#mcp-probe-url")?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			runMcpProbe();
		}
	});
	$("#mcp-probe-add")?.addEventListener("click", async () => {
		if (!lastMcpProbe.value) return;
		const name = ($("#mcp-probe-name")?.value ?? "").trim();
		if (!name) {
			showToast("Give the server a name first.", { kind: "error" });
			return;
		}
		const body = {
			name,
			transport: lastMcpProbe.value.transport,
			url: lastMcpProbe.value.endpoint
		};
		if (lastMcpProbeToken.value) body.headers = { Authorization: `Bearer ${lastMcpProbeToken.value}` };
		await createMcpServer(body, $("#mcp-probe-add"));
	});
	$("#mcp-create-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const transport = $("#mcp-create-transport")?.value ?? "";
		const body = {
			name: ($("#mcp-create-name")?.value ?? "").trim(),
			transport
		};
		if (transport === "stdio") {
			body.command = ($("#mcp-create-command")?.value ?? "").trim();
			body.args = ($("#mcp-create-args")?.value ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
		} else {
			body.url = ($("#mcp-create-url")?.value ?? "").trim();
			const token = ($("#mcp-create-token")?.value ?? "").trim();
			if (token) body.headers = { Authorization: `Bearer ${token}` };
		}
		await createMcpServer(body, $("#mcp-create-form button.btn-primary"));
	});
	$("#mcp-detail-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!selectedMcpId.value) return;
		const server = allMcpServers.value.find((s) => s.id === selectedMcpId.value);
		if (!server) return;
		const body = { name: ($("#mcp-name")?.value ?? "").trim() };
		if (server.transport === "stdio") body.command = ($("#mcp-command")?.value ?? "").trim();
		else body.url = ($("#mcp-url")?.value ?? "").trim();
		const token = server.transport !== "stdio" ? ($("#mcp-token")?.value ?? "").trim() : "";
		try {
			await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}`, {
				method: "PUT",
				body
			});
			if (token) await apiJson(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}/auth`, {
				method: "PUT",
				body: { token }
			});
			showToast("Saved", { kind: "success" });
			closeMcpDetail();
			await fetchMcpServers();
		} catch (err) {
			showToast("Save failed: " + (err.message || err), { kind: "error" });
		}
	});
	$("#mcp-delete")?.addEventListener("click", async () => {
		if (!selectedMcpId.value) return;
		const server = allMcpServers.value.find((s) => s.id === selectedMcpId.value);
		if (!server) return;
		try {
			const res = await authFetch(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}`, { method: "DELETE" });
			if (res.status === 409) {
				const n = ((await res.json()).assigned_agent_group_ids || []).length;
				if (!await showConfirmModal({
					title: "Delete MCP server",
					body: `"${server.name}" is attached to ${n} agent${n === 1 ? "" : "s"}. They lose its tools on their next message.`,
					confirmLabel: "Delete anyway",
					destructive: true
				})) return;
				const force = await authFetch(`/api/mcp-servers/${encodeURIComponent(selectedMcpId.value)}?force=1`, { method: "DELETE" });
				if (!force.ok) {
					showToast(`Failed to delete: ${(await force.json().catch(() => ({}))).error || force.statusText}`, { kind: "error" });
					return;
				}
			} else if (!res.ok) {
				showToast(`Failed to delete: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
				return;
			}
			showToast(`Deleted "${server.name}".`, { kind: "success" });
			closeMcpDetail();
			await fetchMcpServers();
		} catch (err) {
			showToast(`Failed to delete: ${err.message}`, { kind: "error" });
		}
	});
	/**
	* Update the picker trigger button's labels to reflect the currently-
	* assigned model. Two-line layout: name on top, kind+model_id+host underneath.
	* No selection → "Default" / "Built-in Anthropic".
	*/
}
/** The MCP catalog block: search, expand and add-from-catalog. */
function wireMcpCatalog() {
	const block = document.getElementById("mcp-catalog-block");
	const search = document.getElementById("mcp-catalog-search");
	if (!block || !search) return;
	let loaded = false;
	block.addEventListener("toggle", () => {
		if (block.open && !loaded) {
			loaded = true;
			loadMcpCatalog("");
		}
	});
	search.addEventListener("input", () => {
		clearTimeout(mcpCatalogTimer);
		mcpCatalogTimer = setTimeout(() => void loadMcpCatalog(search.value.trim()), 300);
	});
}
//#endregion
//#region src/features/ThreadNameInput.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$37 = ["aria-label"];
//#endregion
//#region src/features/ThreadNameInput.vue
var ThreadNameInput_default = /* @__PURE__ */ defineComponent({
	__name: "ThreadNameInput",
	props: {
		value: { default: "" },
		placeholder: { default: "Thread name…" },
		ariaLabel: {},
		selectAll: {
			type: Boolean,
			default: false
		},
		blurSubmits: {
			type: Boolean,
			default: false
		}
	},
	emits: ["submit", "cancel"],
	setup(__props, { emit: __emit }) {
		/**
		* The inline thread-name input — used for "new thread" and for rename.
		*
		* Replaces makeThreadNameInput(), which built the element imperatively and was
		* appended into three different places. Rendered by ThreadRows now.
		*
		* `settled` is the load-bearing part and is preserved exactly: blur fires after
		* Enter, so without it a submit is followed immediately by a cancel — or, with
		* blurSubmits, by a second submit. It guards the pair, not each handler.
		*
		* `value` and `placeholder` are mutually exclusive, as before: the imperative
		* version set placeholder ONLY when there was no initial value, so a rename
		* input carries no placeholder attribute at all.
		*/
		const props = __props;
		const emit = __emit;
		const el = ref(null);
		let settled = false;
		function cancel() {
			if (settled) return;
			settled = true;
			emit("cancel");
		}
		function submit() {
			if (settled) return;
			const title = el.value?.value.trim() ?? "";
			if (!title || title === props.value) return cancel();
			settled = true;
			emit("submit", title);
		}
		function onKey(e) {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		}
		onMounted(() => {
			setTimeout(() => {
				el.value?.focus();
				if (props.selectAll) el.value?.select();
			}, 0);
		});
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("input", mergeProps({
				ref_key: "el",
				ref: el,
				type: "text",
				class: "thread-add-input",
				maxlength: "80"
			}, __props.value ? { value: __props.value } : { placeholder: __props.placeholder }, {
				"aria-label": __props.ariaLabel,
				onClick: _cache[0] || (_cache[0] = withModifiers(() => {}, ["stop"])),
				onKeydown: onKey,
				onBlur: _cache[1] || (_cache[1] = ($event) => __props.blurSubmits ? submit() : cancel())
			}), null, 16, _hoisted_1$37);
		};
	}
});
//#endregion
//#region src/features/ThreadSwitcher.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$36 = ["onClick"];
var _hoisted_2$32 = { class: "thread-switcher-label" };
var NEW_THREAD$2 = "+ New thread";
//#endregion
//#region src/features/ThreadSwitcher.vue
var ThreadSwitcher_default = /* @__PURE__ */ defineComponent({
	__name: "ThreadSwitcher",
	props: {
		rows: {},
		currentThread: {},
		onPick: { type: Function },
		onCreate: { type: Function },
		onCancel: { type: Function }
	},
	setup(__props) {
		/**
		* The in-room thread switcher — forty-ninth island.
		*
		* Per-instance: openThreadSwitcher creates the popover and mounts an app into
		* it, next to the chat header's '#' button. The sidebar thread tree is hidden on
		* mobile while a room is open, so this is the mobile way to switch threads and
		* create one without backing out.
		*
		* switcherCreate() is absorbed. It did addBtn.replaceWith(input) — replacing a
		* node Vue would own — so the swap is a `creating` ref, and the input is the
		* ThreadNameInput component the room list already uses. blurSubmits stays true:
		* clicking away COMMITS here, which is the prior switcher behaviour and the
		* opposite of the sidebar's inline input.
		*
		* Main chat is always the first row and is never tinted; topic threads carry a
		* dot in their identity colour.
		*/
		const props = __props;
		const creating = ref(false);
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [(openBlock(true), createElementBlock(Fragment, null, renderList(__props.rows, (r) => {
				return openBlock(), createElementBlock("button", {
					key: r.threadId,
					class: normalizeClass(r.threadId === __props.currentThread ? "thread-switcher-item active" : "thread-switcher-item"),
					type: "button",
					role: "menuitem",
					onClick: withModifiers(($event) => props.onPick(r.threadId), ["stop"])
				}, [r.tinted ? (openBlock(), createElementBlock("span", {
					key: 0,
					class: "thread-switcher-dot",
					style: normalizeStyle({ background: r.color })
				}, null, 4)) : createCommentVNode("", true), createElementVNode("span", _hoisted_2$32, toDisplayString(r.label), 1)], 10, _hoisted_1$36);
			}), 128)), creating.value ? (openBlock(), createBlock(ThreadNameInput_default, {
				key: 0,
				"aria-label": "New thread name",
				"blur-submits": true,
				onSubmit: props.onCreate,
				onCancel: props.onCancel
			}, null, 8, ["onSubmit", "onCancel"])) : (openBlock(), createElementBlock("button", {
				key: 1,
				class: "thread-switcher-item thread-switcher-new",
				type: "button",
				onClick: _cache[0] || (_cache[0] = withModifiers(($event) => creating.value = true, ["stop"]))
			}, toDisplayString(NEW_THREAD$2)))], 64);
		};
	}
});
//#endregion
//#region src/features/threads.ts
var deps$17 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideThreadsDeps(provided) {
	Object.assign(deps$17, provided);
}
function roomThreads() {
	return state.threadCache.get(state.currentRoom) || [];
}
function toggleRoomThreads(roomId) {
	if (state.expandedRooms.has(roomId)) {
		state.expandedRooms.delete(roomId);
		deps$17.renderRooms(state.lastRoomsList);
		return;
	}
	state.expandedRooms.add(roomId);
	if (!state.threadCache.has(roomId)) loadRoomThreads(roomId).then(() => {
		if (state.expandedRooms.has(roomId)) deps$17.renderRooms(state.lastRoomsList);
	});
	deps$17.renderRooms(state.lastRoomsList);
}
async function loadRoomThreads(roomId) {
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/threads`);
		state.threadCache.set(roomId, r.ok ? await r.json() ?? [] : []);
	} catch {
		state.threadCache.set(roomId, []);
	}
}
async function loadThreadList(roomId) {
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/threads`);
		if (roomId !== state.currentRoom) return;
		if (!r.ok) {
			state.threadCache.set(roomId, []);
			if (r.status !== 404) showToast("Could not load threads", { kind: "error" });
			return;
		}
		const threads = await r.json();
		const list = Array.isArray(threads) ? threads : [];
		state.threadCache.set(roomId, list);
		for (const t of list) if (t.unread && t.thread_id !== state.currentThread) state.threadUnread.add(t.thread_id);
		updateThreadSyncControls();
	} catch {
		if (roomId !== state.currentRoom) return;
		state.threadCache.set(roomId, []);
		showToast("Could not load threads", { kind: "error" });
	}
}
function openThread(threadId) {
	if (!state.currentRoom || threadId === state.currentThread) return;
	deps$17.hideOtherFullViews();
	$("#chat").hidden = false;
	$("#app").classList.add("in-room");
	$("#app").classList.remove("in-dashboard");
	state.currentThread = threadId;
	localStorage.setItem("lastThread:" + state.currentRoom, threadId);
	state.threadUnread.delete(threadId);
	beginTranscriptSwitch();
	state.ws?.send(JSON.stringify({
		type: "join",
		room_id: state.currentRoom,
		thread_id: threadId
	}));
	updateThreadSyncControls();
}
function updateThreadSyncControls() {
	const inThread = !!(state.currentRoom && state.currentThread && state.currentThread !== "main");
	const sw = $("#thread-switch");
	if (sw) {
		sw.hidden = !state.currentRoom;
		const topicCount = roomThreads().filter((t) => t.kind !== "main").length;
		sw.textContent = topicCount > 0 ? `#${topicCount}` : "#";
		sw.classList.toggle("has-threads", topicCount > 0);
		sw.title = topicCount > 0 ? `${topicCount} thread${topicCount === 1 ? "" : "s"}` : "Threads";
	}
	const sync = $("#thread-sync");
	if (sync) sync.hidden = !inThread;
	const crumb = $("#thread-crumb");
	if (crumb) {
		crumb.hidden = !inThread;
		if (inThread) {
			const thread = roomThreads().find((t) => t.thread_id === state.currentThread);
			const nameEl = $("#thread-crumb-name");
			if (nameEl) {
				nameEl.textContent = thread ? thread.title ?? "" : state.currentThread;
				nameEl.style.setProperty("--thread-color", deps$17.roomColor(state.currentThread));
			}
		}
	}
}
async function createThread(title, roomId = state.currentRoom) {
	try {
		const thread = await apiJson(`/api/rooms/${encodeURIComponent(roomId)}/threads`, {
			method: "POST",
			body: { title }
		});
		if (roomId === state.currentRoom) {
			await loadThreadList(roomId);
			openThread(thread.thread_id);
		} else {
			const room = state.lastRoomsList.find((x) => x.id === roomId);
			deps$17.joinRoom(roomId, room ? room.name : roomId, void 0, thread.thread_id);
		}
	} catch (err) {
		showToast("Could not create thread: " + (err?.message || err), { kind: "error" });
	}
}
function closeThreadSwitcher() {
	switcherApp?.unmount();
	switcherApp = null;
	document.querySelectorAll(".thread-switcher").forEach((m) => m.remove());
}
var switcherApp = null;
function openThreadSwitcher() {
	closeThreadSwitcher();
	if (!state.currentRoom) return;
	const btn = $("#thread-switch");
	if (!btn) return;
	const pop = document.createElement("div");
	pop.className = "thread-switcher";
	pop.setAttribute("role", "menu");
	const rows = [{
		label: "Main chat",
		threadId: "main",
		tinted: false,
		color: ""
	}, ...roomThreads().filter((t) => t.kind !== "main").map((t) => ({
		label: t.title,
		threadId: t.thread_id,
		tinted: true,
		color: deps$17.roomColor(t.thread_id)
	}))];
	switcherApp = createApp(ThreadSwitcher_default, {
		rows,
		currentThread: state.currentThread,
		onPick: (threadId) => {
			closeThreadSwitcher();
			openThread(threadId);
		},
		onCreate: (title) => {
			closeThreadSwitcher();
			createThread(title);
		},
		onCancel: () => closeThreadSwitcher()
	});
	switcherApp.mount(pop);
	btn.parentElement?.appendChild(pop);
	setTimeout(() => document.addEventListener("click", closeThreadSwitcher, { once: true }), 0);
}
async function submitThreadRename(threadId, title) {
	try {
		await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom)}/threads/${encodeURIComponent(threadId)}`, {
			method: "PATCH",
			body: { title }
		});
		await loadThreadList(state.currentRoom);
	} catch (err) {
		showToast("Rename failed: " + (err?.message || err), { kind: "error" });
	}
}
async function deleteThreadConfirm(thread, rowEl) {
	const commit = async () => {
		try {
			await apiJson(`/api/rooms/${encodeURIComponent(state.currentRoom)}/threads/${encodeURIComponent(thread.thread_id)}`, { method: "DELETE" });
			if (state.currentThread === thread.thread_id) openThread("main");
			await loadThreadList(state.currentRoom);
			showToast("Thread deleted", { kind: "success" });
		} catch (err) {
			showToast("Delete failed: " + (err?.message || err), { kind: "error" });
			await loadThreadList(state.currentRoom);
		}
	};
	const row = rowEl || document.querySelector(`.thread-row[data-thread-id="${cssEscape(thread.thread_id)}"]`);
	if (!row) {
		if (await deps$17.showConfirmModal({
			title: `Delete "${thread.title}"?`,
			body: "",
			confirmLabel: "Delete",
			destructive: true
		})) await commit();
		return;
	}
	const width = row.getBoundingClientRect().width;
	const id = thread.thread_id;
	threadUndo.value = {
		...threadUndo.value,
		[id]: {
			label: `Removing ${thread.title}…`,
			width: width ? `${width}px` : "",
			commit: () => {
				clearThreadUndo(id);
				commit();
			}
		}
	};
}
/** The countdown length, read through the dep threads.ts already owns. */
function getUndoSeconds() {
	return 10;
}
/** Disarm a thread's countdown — Undo, or the commit that follows it. */
function clearThreadUndo(threadId) {
	const next = { ...threadUndo.value };
	delete next[threadId];
	threadUndo.value = next;
}
async function syncThread(direction) {
	if (!state.currentRoom || state.currentThread === "main") return;
	const room = state.currentRoom;
	const thread = state.currentThread;
	const isPull = direction === "pull";
	if (!await deps$17.showConfirmModal({
		title: isPull ? "Pull main chat down" : "Push this thread up",
		body: "",
		confirmLabel: isPull ? "Pull down" : "Push up"
	})) return;
	try {
		const r = await authFetch(`/api/rooms/${encodeURIComponent(room)}/threads/${encodeURIComponent(thread)}/${direction}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" }
		});
		if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
		const { copied = 0 } = await r.json();
		if (copied === 0) showToast(isPull ? "Nothing new to pull" : "Nothing new to push", { kind: "info" });
		else showToast(`Copied ${copied} message${copied === 1 ? "" : "s"}`, { kind: "success" });
	} catch (err) {
		showToast("Sync failed: " + (err?.message || err), { kind: "error" });
	}
}
/**
* The thread actions the RoomList island calls. Bundled as one object because
* the island takes them as a single `thread` prop — twelve separate props for
* one cohesive surface reads worse and drifts more easily.
*
* renderThreadList/renderRoomThreads used to be the re-render trigger after
* each of these; the island re-renders from state instead, so the calls that
* only existed to repaint are gone.
*/
var threadActions = {
	open: (threadId) => openThread(threadId),
	create: (title) => {
		state.threadCreating = false;
		createThread(title);
	},
	cancelCreate: () => {
		state.threadCreating = false;
	},
	startCreate: () => {
		state.threadCreating = true;
	},
	rename: (threadId, title) => {
		state.threadRenaming = null;
		submitThreadRename(threadId, title);
	},
	cancelRename: () => {
		state.threadRenaming = null;
	},
	menu: (threadId) => {
		openThreadMenuId.value = openThreadMenuId.value === threadId ? null : threadId;
	},
	startRename: (threadId) => {
		openThreadMenuId.value = null;
		state.threadRenaming = threadId;
	},
	remove: (threadId) => {
		openThreadMenuId.value = null;
		const t = roomThreads().find((x) => x.thread_id === threadId);
		if (t) deleteThreadConfirm(t, null);
	}
};
//#endregion
//#region src/features/UndoTimer.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$35 = { class: "undo-timer" };
var _hoisted_2$31 = { class: "undo-timer-label" };
var _hoisted_3$27 = { class: "undo-timer-bar" };
var UNDO = "Undo";
//#endregion
//#region src/features/UndoTimer.vue
var UndoTimer_default = /* @__PURE__ */ defineComponent({
	__name: "UndoTimer",
	props: {
		label: {},
		seconds: {}
	},
	emits: ["commit", "undo"],
	setup(__props, { emit: __emit }) {
		/**
		* The undo countdown that replaces a row's actions after Keep or Discard.
		*
		* The only undo countdown now. armUndo() is gone: it captured an element's
		* childNodes, replaced them with this markup and re-appended them afterwards,
		* which under Vue means reinserting vnode-managed nodes behind Vue's back —
		* so an island could never call it, and its last caller (the thread delete)
		* was handing it a row that ThreadRows renders.
		*
		* Both users drive it from state keyed by id — cardUndo for skill drafts,
		* threadUndo for threads — and both measure the width BEFORE arming, which is
		* what armUndo's getBoundingClientRect() call was for.
		*
		* The two-frame delay is load-bearing: the fill has to paint at 100% before the
		* transition to 0% starts, or the bar jumps straight to empty.
		*/
		const props = __props;
		const emit = __emit;
		const fill = ref(null);
		let timer = null;
		onMounted(() => {
			requestAnimationFrame(() => requestAnimationFrame(() => {
				if (!fill.value) return;
				fill.value.style.transitionDuration = `${props.seconds}s`;
				fill.value.style.width = "0%";
			}));
			timer = setTimeout(() => emit("commit"), props.seconds * 1e3);
		});
		onUnmounted(() => {
			if (timer) clearTimeout(timer);
		});
		function undo() {
			if (timer) clearTimeout(timer);
			emit("undo");
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("span", _hoisted_1$35, [
				createElementVNode("span", _hoisted_2$31, toDisplayString(__props.label), 1),
				createElementVNode("span", _hoisted_3$27, [createElementVNode("span", {
					ref_key: "fill",
					ref: fill
				}, null, 512)]),
				createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost",
					onClick: undo
				}, toDisplayString(UNDO))
			]);
		};
	}
});
//#endregion
//#region src/features/ThreadRows.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$34 = {
	key: 0,
	class: "thread-loading"
};
var _hoisted_2$30 = ["data-thread-id"];
var _hoisted_3$26 = [
	"data-thread-id",
	"aria-label",
	"onClick",
	"onKeydown"
];
var _hoisted_4$20 = {
	class: "thread-glyph",
	"aria-hidden": "true"
};
var _hoisted_5$17 = { class: "thread-label" };
var _hoisted_6$14 = {
	key: 0,
	class: "thread-unread"
};
var _hoisted_7$10 = ["onClick", "innerHTML"];
var _hoisted_8$8 = {
	key: 3,
	class: "thread-menu"
};
var _hoisted_9$5 = ["onClick"];
var _hoisted_10$5 = ["onClick"];
var RENAME = "Rename";
var DELETE = "Delete";
var NEW_THREAD$1 = "New thread";
var PLUS$1 = "+";
//#endregion
//#region src/features/ThreadRows.vue
var ThreadRows_default = /* @__PURE__ */ defineComponent({
	__name: "ThreadRows",
	props: {
		roomId: {},
		active: { type: Boolean },
		color: { type: Function },
		onOpen: { type: Function },
		onCreate: { type: Function },
		onCancelCreate: { type: Function },
		onStartCreate: { type: Function },
		onRename: { type: Function },
		onCancelRename: { type: Function },
		onMenu: { type: Function },
		onStartRename: { type: Function },
		onDelete: { type: Function },
		undoSeconds: {},
		onUndoDelete: { type: Function }
	},
	setup(__props) {
		/**
		* The thread tree nested under a room row.
		*
		* Replaces BOTH renderRoomThreads (a non-active room's tree) and renderThreadList
		* (the active room's, with rename, kebab and the inline "+"). They rendered the
		* same container class from two different functions with different feature sets;
		* `active` selects which.
		*
		* The "+" placement rule is copied exactly, because it is not obvious:
		*   - creating          → the input replaces it
		*   - no threads yet    → "+" goes on the ROOM row's actions group (rendered by
		*                         RoomList, not here — the empty .thread-list collapses
		*                         via :empty, so a "+" here would cost a line)
		*   - has threads       → "+" sits INSIDE the last thread row, right of its name
		* Only the third case belongs to this component.
		*/
		const KEBAB = lucide("ellipsis");
		/** Bound, not template text — template text carries the surrounding newlines. */
		const props = __props;
		const rows = computed(() => {
			const all = state.threadCache.get(props.roomId);
			if (!Array.isArray(all)) return null;
			return all.filter((t) => t.kind !== "main");
		});
		const glyph = (kind) => kind === "agent" ? "@" : "#";
		/**
		* Only the Undo BUTTON stops the click, not the whole timer.
		*
		* armUndo's caller bound stopPropagation to the button alone, so a click on the
		* label or the bar still reached the row and opened the thread. Listening on the
		* component root and filtering by target reproduces that without adding an
		* element to wrap it in.
		*/
		function stopUndoClick(e) {
			if (e.target?.closest("button")) e.stopPropagation();
		}
		return (_ctx, _cache) => {
			return rows.value === null ? (openBlock(), createElementBlock("div", _hoisted_1$34, "Loading…")) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [(openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (t, i) => {
				return openBlock(), createElementBlock(Fragment, { key: t.thread_id }, [__props.active && t.thread_id === unref(state).threadRenaming ? (openBlock(), createElementBlock("div", {
					key: 0,
					class: "thread-row",
					"data-thread-id": t.thread_id,
					style: normalizeStyle({ "--thread-color": __props.color(t.thread_id) })
				}, [createVNode(ThreadNameInput_default, {
					value: t.title,
					"aria-label": "Rename thread",
					"select-all": true,
					onSubmit: (title) => __props.onRename(t.thread_id, title),
					onCancel: __props.onCancelRename
				}, null, 8, [
					"value",
					"onSubmit",
					"onCancel"
				])], 12, _hoisted_2$30)) : (openBlock(), createElementBlock("div", mergeProps({
					key: 1,
					class: [__props.active && t.thread_id === unref(state).currentThread ? "thread-row active" : "thread-row", unref(threadUndo)[t.thread_id] ? "deleting" : ""],
					"data-thread-id": t.thread_id,
					role: "button",
					tabindex: "0",
					"aria-label": `Open thread ${t.title}`
				}, { ref_for: true }, __props.active && t.thread_id === unref(state).currentThread ? { "aria-current": "true" } : {}, {
					style: {
						"--thread-color": __props.color(t.thread_id),
						width: unref(threadUndo)[t.thread_id]?.width || void 0
					},
					onClick: withModifiers(($event) => __props.onOpen(t.thread_id), ["stop"]),
					onKeydown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							e.stopPropagation();
							__props.onOpen(t.thread_id);
						}
					}
				}), [unref(threadUndo)[t.thread_id] ? (openBlock(), createBlock(UndoTimer_default, {
					key: 0,
					label: unref(threadUndo)[t.thread_id].label,
					seconds: props.undoSeconds,
					onCommit: ($event) => unref(threadUndo)[t.thread_id].commit(),
					onUndo: ($event) => props.onUndoDelete(t.thread_id),
					onClick: stopUndoClick
				}, null, 8, [
					"label",
					"seconds",
					"onCommit",
					"onUndo"
				])) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [
					createElementVNode("span", _hoisted_4$20, toDisplayString(__props.active ? glyph(t.kind) : "#"), 1),
					createElementVNode("span", _hoisted_5$17, toDisplayString(t.title ?? ""), 1),
					__props.active && t.thread_id !== unref(state).currentThread && unref(state).threadUnread.has(t.thread_id) ? (openBlock(), createElementBlock("span", _hoisted_6$14)) : createCommentVNode("", true),
					__props.active && t.kind !== "main" ? (openBlock(), createElementBlock("button", {
						key: 1,
						class: "thread-kebab",
						type: "button",
						"aria-label": "Thread actions",
						onClick: withModifiers(($event) => __props.onMenu(t.thread_id), ["stop"]),
						innerHTML: unref(KEBAB)
					}, null, 8, _hoisted_7$10)) : createCommentVNode("", true),
					__props.active && !unref(state).threadCreating && i === rows.value.length - 1 ? (openBlock(), createElementBlock("button", {
						key: 2,
						class: "thread-add-inline",
						type: "button",
						title: NEW_THREAD$1,
						"aria-label": NEW_THREAD$1,
						onClick: _cache[0] || (_cache[0] = withModifiers((...args) => __props.onStartCreate && __props.onStartCreate(...args), ["stop"]))
					}, toDisplayString(PLUS$1))) : createCommentVNode("", true),
					__props.active && unref(openThreadMenuId) === t.thread_id ? (openBlock(), createElementBlock("div", _hoisted_8$8, [createElementVNode("button", { onClick: withModifiers(($event) => __props.onStartRename(t.thread_id), ["stop"]) }, toDisplayString(RENAME), 8, _hoisted_9$5), unref(state).isOwnerView ? (openBlock(), createElementBlock("button", {
						key: 0,
						class: "danger",
						onClick: withModifiers(($event) => __props.onDelete(t.thread_id), ["stop"])
					}, toDisplayString(DELETE), 8, _hoisted_10$5)) : createCommentVNode("", true)])) : createCommentVNode("", true)
				], 64))], 16, _hoisted_3$26))], 64);
			}), 128)), __props.active && unref(state).threadCreating ? (openBlock(), createBlock(ThreadNameInput_default, {
				key: 0,
				"aria-label": "New thread name",
				onSubmit: __props.onCreate,
				onCancel: __props.onCancelCreate
			}, null, 8, ["onSubmit", "onCancel"])) : createCommentVNode("", true)], 64));
		};
	}
});
//#endregion
//#region src/features/RoomList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$33 = {
	key: 0,
	class: "room-list-empty"
};
var _hoisted_2$29 = {
	key: 0,
	class: "room-divider",
	role: "separator"
};
var _hoisted_3$25 = [
	"data-room-id",
	"draggable",
	"onClick",
	"onKeydown",
	"onDragstart",
	"onDragover",
	"onDragleave",
	"onDrop"
];
var _hoisted_4$19 = [
	"title",
	"aria-label",
	"aria-expanded",
	"onClick"
];
var _hoisted_5$16 = { class: "room-row-name" };
var _hoisted_6$13 = {
	key: 1,
	class: "mention-dot",
	title: "You were mentioned here"
};
var _hoisted_7$9 = ["innerHTML"];
var _hoisted_8$7 = {
	key: 4,
	class: "thread-list"
};
var _hoisted_9$4 = { class: "room-actions" };
var _hoisted_10$4 = ["onClick", "innerHTML"];
var _hoisted_11$3 = ["aria-label", "onClick"];
var _hoisted_12$3 = {
	key: 5,
	class: "thread-list"
};
var _hoisted_13$3 = {
	key: 6,
	class: "room-menu"
};
var _hoisted_14$3 = ["onClick"];
var _hoisted_15$3 = ["onClick"];
var _hoisted_16$3 = ["onClick"];
var _hoisted_17$2 = ["onClick"];
var _hoisted_18$2 = ["onClick"];
var PLUS = "+";
var NEW_THREAD = "New thread";
var MENTION = "@";
/**
* Empty list. A label, not an explanation — matching `'No rooms yet.'` as it
* already reads in the agents pane and the topology canvas. It was briefly two
* role-dependent sentences telling a member to go find an owner; DESIGN.md's
* rule is label-only by default, and the sidebar is the last place that earns
* an exception.
*/
var EMPTY$7 = "No rooms yet.";
/** A filter that matches nothing is a different state from an empty install. */
var NO_MATCH$1 = "No rooms match.";
/** Bound, never template text — template text carries surrounding newlines. */
var MOVE_UP = "Move up";
var MOVE_DOWN = "Move down";
//#endregion
//#region src/features/RoomList.vue
var RoomList_default = /* @__PURE__ */ defineComponent({
	__name: "RoomList",
	props: {
		activityOf: { type: Function },
		color: { type: Function },
		onJoin: { type: Function },
		onPin: { type: Function },
		onMovePin: { type: Function },
		onReorderPin: { type: Function },
		onHide: { type: Function },
		onArchive: { type: Function },
		onToggleThreads: { type: Function },
		onStartAddThread: { type: Function },
		onCreateThread: { type: Function },
		onCancelAddThread: { type: Function },
		thread: {},
		undoSeconds: {},
		onUndoDelete: { type: Function }
	},
	setup(__props) {
		/**
		* The sidebar room list — twenty-sixth island, and the largest.
		*
		* Mounted into <ul id="room-list">, exclusively owned by this module.
		*
		* Four renderers shared this subtree and had to convert together, entangled in
		* BOTH directions: renderRooms built the rows and the .thread-list hosts;
		* renderRoomThreads filled a non-active room's host; renderThreadList filled the
		* active room's AND reached back OUT to append the inline "+" into that row's
		* .room-actions; openThreadMenu appended a menu into a thread row.
		*
		* Two things the imperative version needed and this does not:
		*   - the 400ms RETRY when a kebab menu was open. The menu was a DOM node inside
		*     the list, so a background re-render (a message landing in any room) tore
		*     it down mid-click; the code deferred the whole update instead. The menu is
		*     state now, so a re-render preserves it.
		*   - the scrollTop save/restore around the rebuild. Rows are keyed and patched
		*     rather than replaced, so the scroll position is never lost to begin with.
		*
		* Element ORDER inside a row is exact and non-obvious, taken from the sequence
		* of appends: [chevron], name, [mention|unread], [pin], [thread input], actions,
		* [thread list], [kebab menu last].
		*/
		const props = __props;
		const KEBAB = lucide("ellipsis");
		const PIN_ICON = lucide("pin");
		const byActivity = (a, b) => props.activityOf(b) - props.activityOf(a);
		/** A–Z sorts by the DISPLAYED `#id`, not the room name. */
		const byName = (a, b) => String(a.id).localeCompare(String(b.id));
		/**
		* Name filter, applied BEFORE the pinned/archived grouping so a filtered list
		* keeps its structure — a pinned room that matches stays pinned and stays on
		* top, rather than collapsing into one flat list of hits.
		*
		* Matches the room's `#id` (what the sidebar actually displays) and its name,
		* because operators refer to rooms by both.
		*/
		const matchesFilter = (r, q) => !q || String(r.id ?? "").toLowerCase().includes(q) || String(r.name ?? "").toLowerCase().includes(q);
		const groups = computed(() => {
			const cmp = roomSortAz.value ? byName : byActivity;
			const q = roomFilter.value.trim().toLowerCase();
			const all = (state.lastRoomsList ?? []).filter((r) => matchesFilter(r, q));
			const visible = showHidden.value ? [...all] : all.filter((r) => !r.hidden);
			const active = visible.filter((r) => !r.archived);
			return {
				pinned: active.filter((r) => r.pinned).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0) || byActivity(a, b)),
				unpinned: active.filter((r) => !r.pinned).sort(cmp),
				archived: visible.filter((r) => r.archived).sort(cmp)
			};
		});
		/** Divider sentinel — only when BOTH groups are non-empty. */
		const showDivider = computed(() => groups.value.pinned.length > 0 && groups.value.unpinned.length > 0);
		const rendered = computed(() => [
			...groups.value.pinned,
			...groups.value.unpinned,
			...showArchived.value ? groups.value.archived : []
		]);
		/** Index within the pinned group — drives Move up / Move down availability. */
		const pinIndex = (id) => groups.value.pinned.findIndex((r) => r.id === id);
		/**
		* Pinning is drag-and-drop; the kebab keeps Unpin for pinned rooms. On touch —
		* where HTML5 drag is unreliable — also keep a Pin action so mobile can pin.
		*/
		const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
		function onDragStart(room, e) {
			if (e.dataTransfer) {
				e.dataTransfer.setData("text/plain", room.id);
				e.dataTransfer.effectAllowed = "move";
			}
			const list = document.getElementById("room-list");
			if (room.pinned) {
				draggedPinId.value = room.id;
				list.classList.add("room-list-reordering");
			} else {
				draggedPinId.value = null;
				list.classList.add("room-list-dragging");
			}
		}
		function onDragEnd() {
			draggedPinId.value = null;
			document.getElementById("room-list").classList.remove("room-list-dragging", "room-list-reordering");
			dropMarker.value = {};
		}
		/** Above or below, decided by which half of the row the cursor is over. */
		function overHalf(el, y) {
			const rect = el.getBoundingClientRect();
			return y > rect.top + rect.height / 2;
		}
		function onRowDragOver(room, e) {
			if (!draggedPinId.value || draggedPinId.value === room.id) return;
			e.preventDefault();
			e.stopPropagation();
			dropMarker.value = { [room.id]: overHalf(e.currentTarget, e.clientY) ? "after" : "before" };
		}
		function onRowDragLeave(room) {
			const next = { ...dropMarker.value };
			delete next[room.id];
			dropMarker.value = next;
		}
		function onRowDrop(room, e) {
			if (!draggedPinId.value || draggedPinId.value === room.id) return;
			e.preventDefault();
			e.stopPropagation();
			const after = overHalf(e.currentTarget, e.clientY);
			const moved = draggedPinId.value;
			draggedPinId.value = null;
			dropMarker.value = {};
			document.getElementById("room-list").classList.remove("room-list-reordering");
			props.onReorderPin(moved, room.id, after);
		}
		/**
		* Built as a string and bound through v-bind of an object, so a row with NO
		* classes emits no class attribute at all. :class="" would emit class="" —
		* the difference the very first island was caught on.
		*/
		function rowClass(room) {
			const marker = dropMarker.value[room.id];
			const parts = [
				room.archived ? "archived" : "",
				room.id === state.currentRoom ? "active" : "",
				marker ? "drop-" + marker : "",
				expanded(room) || adding(room) ? "has-threads" : ""
			].filter(Boolean);
			return parts.length ? parts.join(" ") : void 0;
		}
		function toggleMenu(room) {
			openMenuRoomId.value = openMenuRoomId.value === room.id ? null : room.id;
		}
		function onKey(e, room) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onJoin(room.id, room.name);
			}
		}
		/** A room shows its inline new-thread input instead of the "+". */
		const adding = (room) => state.threadAddRoom === room.id && room.id !== state.currentRoom;
		/** Expanded rooms nest a tree; the active room's is expanded on join. */
		const expanded = (room) => state.expandedRooms.has(room.id);
		/** The active room's "+" moves onto the last thread row once threads exist. */
		const activeHasThreads = computed(() => (state.threadCache.get(state.currentRoom) ?? []).some((t) => t.kind !== "main"));
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [rendered.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$33, toDisplayString(unref(roomFilter).trim() ? NO_MATCH$1 : EMPTY$7), 1)) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(rendered.value, (room) => {
				return openBlock(), createElementBlock(Fragment, { key: room.id }, [showDivider.value && room.id === groups.value.unpinned[0]?.id ? (openBlock(), createElementBlock("li", _hoisted_2$29)) : createCommentVNode("", true), createElementVNode("li", mergeProps({
					"data-room-id": room.id,
					draggable: !room.archived || void 0,
					role: "button",
					tabindex: "0",
					style: { borderLeftColor: __props.color(room.id) }
				}, { ref_for: true }, rowClass(room) ? { class: rowClass(room) } : {}, {
					onClick: ($event) => __props.onJoin(room.id, room.name),
					onKeydown: ($event) => onKey($event, room),
					onDragstart: ($event) => onDragStart(room, $event),
					onDragend: onDragEnd,
					onDragover: ($event) => room.pinned ? onRowDragOver(room, $event) : void 0,
					onDragleave: ($event) => room.pinned ? onRowDragLeave(room) : void 0,
					onDrop: ($event) => room.pinned ? onRowDrop(room, $event) : void 0
				}), [
					(room.thread_count || 0) > 0 ? (openBlock(), createElementBlock("button", {
						key: 0,
						class: "room-thread-toggle",
						type: "button",
						title: `${room.thread_count} thread${room.thread_count === 1 ? "" : "s"}`,
						"aria-label": `${expanded(room) ? "Collapse" : "Show"} ${room.thread_count} thread${room.thread_count === 1 ? "" : "s"}`,
						"aria-expanded": expanded(room) ? "true" : "false",
						onClick: withModifiers(($event) => __props.onToggleThreads(room.id), ["stop"])
					}, toDisplayString(expanded(room) ? "▾" : "▸"), 9, _hoisted_4$19)) : createCommentVNode("", true),
					createElementVNode("span", _hoisted_5$16, "#" + toDisplayString(room.id), 1),
					unref(state).mentionedRooms.has(room.id) ? (openBlock(), createElementBlock("span", _hoisted_6$13, toDisplayString(MENTION))) : unref(state).unreadRooms.has(room.id) ? (openBlock(), createElementBlock("span", {
						key: 2,
						class: "unread-dot",
						style: normalizeStyle({ background: __props.color(room.id) })
					}, null, 4)) : createCommentVNode("", true),
					room.pinned ? (openBlock(), createElementBlock("span", {
						key: 3,
						class: "room-pin-indicator",
						"aria-label": "Pinned",
						innerHTML: unref(PIN_ICON)
					}, null, 8, _hoisted_7$9)) : createCommentVNode("", true),
					adding(room) ? (openBlock(), createElementBlock("div", _hoisted_8$7, [createVNode(ThreadNameInput_default, {
						"aria-label": `New thread in #${room.id}`,
						onSubmit: (title) => __props.onCreateThread(room.id, title),
						onCancel: __props.onCancelAddThread
					}, null, 8, [
						"aria-label",
						"onSubmit",
						"onCancel"
					])])) : createCommentVNode("", true),
					createElementVNode("span", _hoisted_9$4, [createElementVNode("button", {
						class: "room-kebab",
						type: "button",
						"aria-label": "Room actions",
						onClick: withModifiers(($event) => toggleMenu(room), ["stop"]),
						innerHTML: unref(KEBAB)
					}, null, 8, _hoisted_10$4), room.id !== unref(state).currentRoom && !adding(room) ? (openBlock(), createElementBlock("button", {
						key: 0,
						class: "thread-add-inline",
						type: "button",
						title: NEW_THREAD,
						"aria-label": `New thread in #${room.id}`,
						onClick: withModifiers(($event) => __props.onStartAddThread(room.id), ["stop"])
					}, toDisplayString(PLUS), 8, _hoisted_11$3)) : room.id === unref(state).currentRoom && expanded(room) && !unref(state).threadCreating && !activeHasThreads.value ? (openBlock(), createElementBlock("button", {
						key: 1,
						class: "thread-add-inline",
						type: "button",
						title: NEW_THREAD,
						"aria-label": "New thread",
						onClick: _cache[0] || (_cache[0] = withModifiers(($event) => __props.thread.startCreate(), ["stop"]))
					}, toDisplayString(PLUS))) : createCommentVNode("", true)]),
					expanded(room) ? (openBlock(), createElementBlock("div", _hoisted_12$3, [createVNode(ThreadRows_default, {
						"room-id": room.id,
						active: room.id === unref(state).currentRoom,
						color: __props.color,
						"on-open": __props.thread.open,
						"on-create": __props.thread.create,
						"on-cancel-create": __props.thread.cancelCreate,
						"on-start-create": __props.thread.startCreate,
						"on-rename": __props.thread.rename,
						"on-cancel-rename": __props.thread.cancelRename,
						"on-menu": __props.thread.menu,
						"on-start-rename": __props.thread.startRename,
						"on-delete": __props.thread.remove,
						"undo-seconds": props.undoSeconds,
						"on-undo-delete": props.onUndoDelete
					}, null, 8, [
						"room-id",
						"active",
						"color",
						"on-open",
						"on-create",
						"on-cancel-create",
						"on-start-create",
						"on-rename",
						"on-cancel-rename",
						"on-menu",
						"on-start-rename",
						"on-delete",
						"undo-seconds",
						"on-undo-delete"
					])])) : createCommentVNode("", true),
					unref(openMenuRoomId) === room.id ? (openBlock(), createElementBlock("div", _hoisted_13$3, [
						room.pinned || unref(coarsePointer) ? (openBlock(), createElementBlock("button", {
							key: 0,
							type: "button",
							onClick: withModifiers(($event) => {
								openMenuRoomId.value = null;
								__props.onPin(room.id, !room.pinned);
							}, ["stop"])
						}, toDisplayString(room.pinned ? "Unpin" : "Pin"), 9, _hoisted_14$3)) : createCommentVNode("", true),
						room.pinned && groups.value.pinned.length > 1 && pinIndex(room.id) > 0 ? (openBlock(), createElementBlock("button", {
							key: 1,
							type: "button",
							onClick: withModifiers(($event) => {
								openMenuRoomId.value = null;
								__props.onMovePin(room.id, -1);
							}, ["stop"])
						}, toDisplayString(MOVE_UP), 8, _hoisted_15$3)) : createCommentVNode("", true),
						room.pinned && groups.value.pinned.length > 1 && pinIndex(room.id) < groups.value.pinned.length - 1 ? (openBlock(), createElementBlock("button", {
							key: 2,
							type: "button",
							onClick: withModifiers(($event) => {
								openMenuRoomId.value = null;
								__props.onMovePin(room.id, 1);
							}, ["stop"])
						}, toDisplayString(MOVE_DOWN), 8, _hoisted_16$3)) : createCommentVNode("", true),
						createElementVNode("button", {
							type: "button",
							onClick: withModifiers(($event) => {
								openMenuRoomId.value = null;
								__props.onHide(room.id, !room.hidden);
							}, ["stop"])
						}, toDisplayString(room.hidden ? "Unhide" : "Hide"), 9, _hoisted_17$2),
						room.canArchive ? (openBlock(), createElementBlock("button", {
							key: 3,
							type: "button",
							onClick: withModifiers(($event) => {
								openMenuRoomId.value = null;
								__props.onArchive(room.id, !room.archived);
							}, ["stop"])
						}, toDisplayString(room.archived ? "Unarchive" : "Archive"), 9, _hoisted_18$2)) : createCommentVNode("", true)
					])) : createCommentVNode("", true)
				], 16, _hoisted_3$25)], 64);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/rooms.ts
var deps$16 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideRoomsDeps(provided) {
	Object.assign(deps$16, provided);
}
var ROOM_COLORS = [
	"#4fc3f7",
	"#69f0ae",
	"#ffd54f",
	"#ff8a80",
	"#b388ff",
	"#80deea",
	"#ffab91",
	"#a5d6a7"
];
function roomColor(roomId) {
	let hash = 0;
	for (let i = 0; i < roomId.length; i++) hash = (hash << 5) - hash + roomId.charCodeAt(i) | 0;
	return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
}
function snapshotRoomImages() {
	const imgs = document.querySelectorAll("#messages .file-image-preview");
	return Array.from(imgs).map((el) => ({
		url: el.src,
		alt: el.alt || ""
	}));
}
var roomListApp = null;
function mountRoomList() {
	if (roomListApp) return;
	const host = $("#room-list");
	if (!host) return;
	host.addEventListener("dragover", (e) => {
		if (!host.classList.contains("room-list-dragging")) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	});
	host.addEventListener("drop", async (e) => {
		if (!host.classList.contains("room-list-dragging")) return;
		e.preventDefault();
		const id = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
		host.classList.remove("room-list-dragging");
		if (id) await toggleRoomPin(id, true);
	});
	roomListApp = createApp(RoomList_default, {
		activityOf,
		color: roomColor,
		onJoin: (roomId, name) => joinRoom(roomId, name),
		onPin: (roomId, pin) => void toggleRoomPin(roomId, pin),
		onMovePin: (roomId, delta) => void movePinnedRoom(roomId, delta),
		onReorderPin: (moved, target, after) => void reorderPinnedRoom(moved, target, after),
		onHide: (roomId, hide) => void toggleRoomHide(roomId, hide),
		onArchive: (roomId, archive) => void toggleRoomArchive(roomId, archive),
		onToggleThreads: (roomId) => toggleRoomThreads(roomId),
		onStartAddThread: (roomId) => {
			state.threadAddRoom = roomId;
			state.threadCreating = false;
		},
		onCreateThread: (roomId, title) => {
			state.threadAddRoom = null;
			createThread(title, roomId);
		},
		onCancelAddThread: () => {
			state.threadAddRoom = null;
		},
		thread: threadActions,
		undoSeconds: getUndoSeconds(),
		onUndoDelete: (threadId) => clearThreadUndo(threadId)
	});
	roomListApp.mount(host);
	watchEffect(() => {
		const btn = $("#create-room-btn");
		if (btn) btn.hidden = !state.isOwnerView;
	});
}
/**
* Sync the toggles the island reads, and mount it.
*
* The rows themselves come from state.lastRoomsList, which is already reactive,
* so this does NOT need calling for every change — but every existing caller
* still works, and the two count-bearing buttons outside the list are updated
* here because they are outside the mount point.
*/
function renderRooms(rooms) {
	const all = rooms ?? state.lastRoomsList ?? [];
	mountRoomList();
	const archivedCount = (showHidden.value ? all : all.filter((r) => !r.hidden)).filter((r) => r.archived).length;
	const toggleBtn = $("#archived-toggle");
	toggleBtn.hidden = archivedCount === 0;
	if (archivedCount) toggleBtn.textContent = showArchived.value ? `Hide ${archivedCount} archived` : `Show ${archivedCount} archived`;
	const hiddenCount = all.filter((r) => r.hidden).length;
	const hiddenBtn = $("#hidden-toggle");
	hiddenBtn.hidden = hiddenCount === 0;
	if (hiddenCount) hiddenBtn.textContent = showHidden.value ? `Hide ${hiddenCount} hidden` : `Show ${hiddenCount} hidden`;
}
async function toggleRoomArchive(roomId, archive) {
	const target = state.lastRoomsList.find((r) => r.id === roomId);
	if (target) target.archived = archive;
	renderRooms(state.lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${archive ? "archive" : "unarchive"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomArchive failed:", err);
		if (target) target.archived = !archive;
		renderRooms(state.lastRoomsList);
	}
}
async function reorderPinnedRoom(movedId, targetId, after) {
	const order = state.lastRoomsList.filter((r) => r.pinned && !r.archived).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0)).map((r) => r.id);
	const from = order.indexOf(movedId);
	if (from === -1) return;
	order.splice(from, 1);
	let to = order.indexOf(targetId);
	if (to === -1) return;
	if (after) to += 1;
	order.splice(to, 0, movedId);
	order.forEach((id, i) => {
		const r = state.lastRoomsList.find((x) => x.id === id);
		if (r) r.pin_position = i;
	});
	renderRooms(state.lastRoomsList);
	try {
		const res = await authFetch("/api/rooms/pins/order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ order })
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("reorderPinnedRoom failed:", err);
	}
}
async function movePinnedRoom(roomId, dir) {
	const order = state.lastRoomsList.filter((r) => r.pinned && !r.archived).sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0)).map((r) => r.id);
	const i = order.indexOf(roomId);
	const j = i + dir;
	if (i === -1 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j], order[i]];
	order.forEach((id, k) => {
		const r = state.lastRoomsList.find((x) => x.id === id);
		if (r) r.pin_position = k;
	});
	renderRooms(state.lastRoomsList);
	try {
		const res = await authFetch("/api/rooms/pins/order", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ order })
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("movePinnedRoom failed:", err);
	}
}
async function toggleRoomPin(roomId, pin) {
	const target = state.lastRoomsList.find((r) => r.id === roomId);
	if (target) target.pinned = pin;
	renderRooms(state.lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${pin ? "pin" : "unpin"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomPin failed:", err);
		if (target) target.pinned = !pin;
		renderRooms(state.lastRoomsList);
	}
}
async function toggleRoomHide(roomId, hide) {
	const target = state.lastRoomsList.find((r) => r.id === roomId);
	if (target) target.hidden = hide;
	renderRooms(state.lastRoomsList);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${hide ? "hide" : "unhide"}`, {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		console.error("toggleRoomHide failed:", err);
		if (target) target.hidden = !hide;
		renderRooms(state.lastRoomsList);
	}
}
function joinRoom(roomId, roomName, jumpMessageId, initialThread) {
	state.pendingJumpMessageId = jumpMessageId || null;
	state.pendingSendAfterJoin = null;
	closeAgentDetail();
	closeRoomDetail();
	deps$16.closeModelDetail();
	closeMcpDetail();
	deps$16.hideOtherFullViews();
	$("#chat").hidden = false;
	endAllAgentTurns();
	const prevRoom = state.currentRoom;
	state.currentRoom = roomId;
	if (prevRoom && prevRoom !== roomId) state.expandedRooms.delete(prevRoom);
	state.expandedRooms.add(roomId);
	state.threadAddRoom = null;
	state.unreadRooms.delete(roomId);
	state.mentionedRooms.delete(roomId);
	refreshRoomAutoLearn(roomId);
	updateUnreadDots();
	deps$16.updateUserCredsBanner(roomId);
	const roomAgent = state.allAgents.find((b) => b.room_id === roomId);
	if (roomAgent) state.agentName = roomAgent.name;
	$("#app").classList.add("in-room");
	$("#app").classList.remove("in-dashboard");
	for (const t of state.typingUsers.values()) clearTimeout(t.timeout);
	state.typingUsers.clear();
	deps$16.renderTypingIndicator();
	$("#members-panel").hidden = true;
	$("#members-overlay").classList.remove("visible");
	deps$16.renderMembers([]);
	beginTranscriptSwitch();
	state.currentThread = initialThread || "main";
	localStorage.setItem("lastThread:" + roomId, state.currentThread);
	state.threadUnread.clear();
	state.threadCache.delete(roomId);
	updateThreadSyncControls();
	state.ws?.send(JSON.stringify({
		type: "join",
		room_id: roomId,
		thread_id: state.currentThread
	}));
	loadThreadList(roomId);
	localStorage.setItem("lastRoom", roomId);
	$("#room-name").textContent = `#${roomId}`;
	$("#message-input").disabled = false;
	const learnBtn = $("#learn-btn");
	if (learnBtn) {
		learnBtn.disabled = false;
		learnBtn.hidden = !state.learningMasterEnabled;
	}
	deps$16.hideLearnNudge();
	learnTurnToolCount.value = 0;
	$("#message-form button[type=submit]").disabled = false;
	showRoomSettingsToggle(true);
	if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
	refreshWiredAgentsForCurrentRoom();
	deps$16.fetchMentionablePeople();
}
function clearRoomSearch() {
	roomFilter.value = "";
	const list = $("#search-results");
	if (list) {
		list.hidden = true;
		list.innerHTML = "";
	}
	const roomList = $("#room-list");
	if (roomList) roomList.hidden = false;
	const sortBtn = $("#room-sort-az");
	if (sortBtn) sortBtn.hidden = false;
	const close = $("#room-search-close");
	if (close) close.hidden = true;
}
async function continueRoomImport(up) {
	const p = up.preview;
	const el = document.createElement("div");
	const line = (t, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = t;
		el.appendChild(d);
	};
	line(`${p.manifest.entity.name} → imports as #${p.suggestedRoomId}`);
	line(`${p.manifest.counts.messages} messages · ${p.manifest.counts.threads} threads · ${p.manifest.counts.files} files`);
	const found = p.agents.filter((a) => a.found).map((a) => a.name);
	const missing = p.agents.filter((a) => !a.found).map((a) => a.name);
	if (found.length) line(`Re-wires agents: ${found.join(", ")}`);
	if (missing.length) line(`⚠ Agents not on this install (wiring skipped): ${missing.join(", ")}`, "import-warning");
	if (!await deps$16.showConfirmModal({
		title: "Import this room?",
		body: el,
		confirmLabel: "Import"
	})) return;
	try {
		const out = await apiJson("/api/rooms/import/apply", {
			method: "POST",
			body: { token: up.token }
		});
		showToast(`Imported #${out.roomId} — ${out.messages} messages`, { kind: "success" });
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	}
}
function showRoomSettingsToggle(visible) {
	$("#room-name").classList.toggle("has-settings", visible);
}
async function openRoomDetail(roomId) {
	selectedRoomId.value = roomId;
	closeAgentDetail();
	closeMcpDetail();
	$("#room-create-view").hidden = true;
	$("#room-edit-view").hidden = false;
	const room = state.lastRoomsList.find((r) => r.id === roomId);
	$("#room-detail-title").textContent = room ? `${room.name} — settings` : "Room settings";
	const renameField = $("#room-rename-field");
	if (state.isOwnerView && room) {
		renameField.hidden = false;
		$("#room-rename-input").value = room.name || "";
	} else renameField.hidden = true;
	const archiveBtn = $("#room-archive-toggle");
	if (room && room.canArchive) {
		archiveBtn.hidden = false;
		archiveBtn.textContent = room.archived ? "Unarchive room" : "Archive room";
	} else archiveBtn.hidden = true;
	await refreshRoomWiredAgents(roomId);
	const credSection = $("#room-credential-mode-section");
	if (credSection) {
		if (room && room.canArchive) {
			credSection.hidden = false;
			document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.remove("active"));
			const hintEl = $("#room-cred-default-hint");
			if (hintEl) hintEl.textContent = "";
			authFetch(`/api/rooms/${encodeURIComponent(roomId)}/credential-mode`).then((r) => r.ok ? r.json() : null).then((d) => {
				if (!d) {
					if (hintEl) hintEl.textContent = "(couldn’t load — try reopening)";
					return;
				}
				const effective = d.mode === "inherit" ? d.defaultMode : d.mode;
				document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.toggle("active", b.dataset.value === effective));
				if (hintEl) hintEl.textContent = "";
			}).catch(() => {
				if (hintEl) hintEl.textContent = "(couldn’t load — try reopening)";
			});
		} else credSection.hidden = true;
	}
	$("#room-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#agent-detail").hidden = true;
}
function closeRoomDetail() {
	$("#room-detail").hidden = true;
	$("#room-edit-view").hidden = false;
	$("#room-create-view").hidden = true;
	selectedRoomId.value = null;
}
async function saveRoomName() {
	const id = selectedRoomId.value;
	if (!id) return;
	const name = $("#room-rename-input").value.trim();
	if (!name) {
		showToast("Enter a room name", { kind: "error" });
		return;
	}
	try {
		await apiJson(`/api/rooms/${encodeURIComponent(id)}/name`, {
			method: "PUT",
			body: { name }
		});
		showToast("Room renamed", { kind: "success" });
	} catch (err) {
		showToast("Rename failed: " + (err?.message || err), { kind: "error" });
	}
}
async function deleteCurrentRoom() {
	if (!selectedRoomId.value) return;
	const room = state.lastRoomsList.find((r) => r.id === selectedRoomId.value);
	const label = room ? room.name : selectedRoomId.value;
	if (!await deps$16.showConfirmModal({
		title: "Delete room",
		body: `Delete room "${label}"? Wired agents will be preserved — delete them separately if you want them gone.`,
		confirmLabel: "Delete",
		destructive: true
	})) return;
	const roomToClose = selectedRoomId.value;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomToClose)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to delete room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Deleted room "${label}".`, { kind: "success" });
		closeRoomDetail();
		if (state.currentRoom === roomToClose) {
			state.currentRoom = null;
			$("#room-name").textContent = "Select a room";
			$("#message-input").disabled = true;
			$("#message-form button[type=submit]").disabled = true;
			transcriptEmpty.value = "Select a room from the sidebar to start chatting";
			showRoomSettingsToggle(false);
		}
	} catch (err) {
		showToast("Failed to delete room: " + err?.message, { kind: "error" });
	}
}
function toggleRoomSettings() {
	if (!state.currentRoom) return;
	if (selectedRoomId.value === state.currentRoom && !$("#room-detail").hidden) closeRoomDetail();
	else openRoomDetail(state.currentRoom);
}
async function openRoomCreate() {
	selectedRoomId.value = null;
	closeAgentDetail();
	$("#room-edit-view").hidden = true;
	$("#room-create-view").hidden = false;
	$("#room-create-name").value = "";
	$("#room-create-new-name").value = "";
	$("#room-create-new-instructions").value = "";
	$("#room-create-new-block").hidden = true;
	await fetchAgents();
	renderRoomCreateAgentChecklist();
	$("#room-detail").hidden = false;
	$("#members-panel").hidden = true;
	$("#agent-detail").hidden = true;
	$("#room-create-name").focus();
}
async function refreshRoomAutoLearn(roomId) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/learning`);
		if (!res.ok) return;
		const cfg = await res.json();
		roomAutoLearn.set(roomId, cfg.autoTrigger === true);
	} catch {}
}
async function putRoomLearning(patch) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/learning`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
		showToast("Learning settings saved for this room");
		refreshRoomAutoLearn(state.currentRoom);
		return true;
	} catch (err) {
		toastError(err, "Could not save");
		return false;
	}
}
var searchDebounce;
var searchResultsApp = null;
function mountSearchResults() {
	if (searchResultsApp) return;
	const host = $("#search-results");
	if (!host) return;
	searchResultsApp = createApp(SearchResults_default);
	searchResultsApp.mount(host);
}
function renderSearchResults(results) {
	const list = $("#search-results");
	if (!list) return;
	mountSearchResults();
	searchRows.value = (results || []).map((r) => ({
		id: String(r.id),
		roomId: String(r.roomId),
		roomName: String(r.roomName),
		time: relativeTime(r.createdAt),
		snipHtml: `<span class="search-result-sender">${esc(r.sender)}:</span> ` + esc(r.snippet || "").replace(/«/g, "<mark>").replace(/»/g, "</mark>")
	}));
	list.hidden = false;
	const sortBtn = $("#room-sort-az");
	if (sortBtn) sortBtn.hidden = true;
}
function relativeTime(ts) {
	const diff = Date.now() - (typeof ts === "number" ? ts : new Date(ts).getTime());
	if (diff < 0 || diff < 6e4) return "just now";
	if (diff < 36e5) return `${Math.floor(diff / 6e4)}m ago`;
	if (diff < 864e5) return `${Math.floor(diff / 36e5)}h ago`;
	return `${Math.floor(diff / 864e5)}d ago`;
}
function wireRoomsPanel() {
	$("#room-search")?.addEventListener("input", (e) => {
		const q = e.target.value.trim();
		roomFilter.value = q;
		const closeBtn = $("#room-search-close");
		if (closeBtn) closeBtn.hidden = !q;
		clearTimeout(searchDebounce);
		if (!q) {
			clearRoomSearch();
			return;
		}
		searchDebounce = setTimeout(async () => {
			try {
				const r = await authFetch(`/api/search?q=${encodeURIComponent(q)}`);
				if (!r.ok) return renderSearchResults([]);
				renderSearchResults((await r.json()).results || []);
			} catch {
				renderSearchResults([]);
			}
		}, 250);
	});
	$("#room-search-close")?.addEventListener("click", () => {
		const input = $("#room-search");
		if (input) input.value = "";
		clearRoomSearch();
		if (input) input.blur();
	});
	$("#search-results")?.addEventListener("click", (e) => {
		const li = e.target?.closest(".search-result");
		if (!li) return;
		const { roomId, roomName, messageId } = li.dataset;
		$("#search-results .search-result.active")?.classList.remove("active");
		li.classList.add("active");
		joinRoom(roomId, roomName, messageId);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		const list = $("#search-results");
		if (!list || list.hidden) return;
		const input = $("#room-search");
		if (input) input.value = "";
		clearRoomSearch();
	});
	$("#room-name")?.addEventListener("click", toggleRoomSettings);
}
function wireRoomDetail1() {
	$("#room-name")?.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggleRoomSettings();
		}
	});
}
function wireRoomDetail2() {
	$("#room-credential-modes")?.addEventListener("click", async (e) => {
		const btn = e.target?.closest(".setting-option");
		if (!btn || !selectedRoomId.value) return;
		const mode = btn.dataset.value;
		const r = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId.value)}/credential-mode`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ mode })
		});
		if (r.ok) {
			document.querySelectorAll("#room-credential-modes .setting-option").forEach((b) => b.classList.toggle("active", b === btn));
			const hintEl = $("#room-cred-default-hint");
			if (hintEl) hintEl.textContent = "";
			showToast(`User credentials: ${{
				disabled: "off",
				optional: "optional",
				required: "required"
			}[mode ?? ""] ?? mode}.`, { kind: "success" });
			if (selectedRoomId.value === state.currentRoom) updateUserCredsBanner(state.currentRoom);
		} else showToast("Failed to set mode: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
	});
}
function wireRoomDetail3() {
	$("#room-rename-input")?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveRoomName();
		}
	});
	$("#room-archive-toggle")?.addEventListener("click", async () => {
		if (!selectedRoomId.value) return;
		const room = state.lastRoomsList.find((r) => r.id === selectedRoomId.value);
		if (!room) return;
		await toggleRoomArchive(selectedRoomId.value, !room.archived);
		if (!$("#room-detail")?.hidden) openRoomDetail(selectedRoomId.value);
	});
}
function wireRoomDetail4() {
	$("#archived-toggle")?.addEventListener("click", () => {
		showArchived.value = !showArchived.value;
		sessionStorage.setItem("webchat:showArchived", showArchived.value ? "1" : "0");
		if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
	});
	$("#hidden-toggle")?.addEventListener("click", () => {
		showHidden.value = !showHidden.value;
		sessionStorage.setItem("webchat:showHidden", showHidden.value ? "1" : "0");
		if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
	});
}
function wireRoomDetail5() {
	$("#room-create-toggle-new")?.addEventListener("click", () => {
		const newBlock = $("#room-create-new-block");
		if (!newBlock) return;
		newBlock.hidden = !newBlock.hidden;
		if (!newBlock.hidden) $("#room-create-new-name")?.focus();
	});
}
/** The room-create form: name, instructions and agent selection. */
function wireRoomCreate() {
	$("#room-create-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const name = ($("#room-create-name")?.value ?? "").trim();
		if (!name) return;
		const boxes = $("#room-create-existing-agents")?.querySelectorAll("input[type=checkbox]");
		const checked = Array.from(boxes ?? []).filter((cb) => cb.checked).map((cb) => ({
			kind: "existing",
			id: cb.value
		}));
		const newName = ($("#room-create-new-name")?.value ?? "").trim();
		const refs = [...checked];
		if (newName) refs.push({
			kind: "new",
			name: newName,
			instructions: ($("#room-create-new-instructions")?.value ?? "") || void 0
		});
		if (refs.length === 0) {
			showToast("Pick at least one existing agent or create a new one inline.", { kind: "error" });
			return;
		}
		try {
			const res = await authFetch("/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					agents: refs
				})
			});
			if (!res.ok) {
				showToast("Failed to create room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
				return;
			}
			const body = await res.json();
			closeRoomDetail();
			await fetchAgents();
			if (body.room) joinRoom(body.room.id, body.room.name);
		} catch (err) {
			showToast("Failed to create room: " + err.message, { kind: "error" });
		}
	});
}
function updateUnreadDots() {
	if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
}
function activityOf(room) {
	return Math.max(room.last_activity || room.created_at || 0, state.roomActivity.get(room.id) || 0);
}
//#endregion
//#region src/features/files.ts
var deps$15 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideFilesDeps(provided) {
	Object.assign(deps$15, provided);
}
function formatFileSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
var pendingFileSeq = 0;
var pendingThumbUrls = /* @__PURE__ */ new Map();
function stageFile(file) {
	if (!state.currentRoom) return;
	const id = ++pendingFileSeq;
	pendingFiles.value.push({
		id,
		file
	});
	renderFilePreview();
	const input = $("#message-input");
	input.focus();
	input.placeholder = pendingFiles.value.length === 1 ? `Add a message about ${file.name}…` : `Add a message about ${pendingFiles.value.length} files…`;
}
function stageFiles(fileList) {
	for (const f of fileList) stageFile(f);
}
function removeStagedFile(id) {
	const url = pendingThumbUrls.get(id);
	if (url) {
		URL.revokeObjectURL(url);
		pendingThumbUrls.delete(id);
	}
	pendingFiles.value = pendingFiles.value.filter((p) => p.id !== id);
	if (pendingFiles.value.length === 0) clearStagedFiles();
	else {
		renderFilePreview();
		$("#message-input").placeholder = pendingFiles.value.length === 1 ? `Add a message about ${pendingFiles.value[0].file.name}…` : `Add a message about ${pendingFiles.value.length} files…`;
	}
}
function clearStagedFiles() {
	for (const url of pendingThumbUrls.values()) URL.revokeObjectURL(url);
	pendingThumbUrls.clear();
	pendingFiles.value = [];
	const preview = $("#file-preview");
	if (preview) {
		preview.hidden = true;
		preview.innerHTML = "";
	}
	$("#message-input").placeholder = "Message…";
}
var filePreviewApp = null;
function mountFilePreview() {
	if (filePreviewApp) return;
	const host = $("#file-preview");
	if (!host) return;
	filePreviewApp = createApp(FilePreview_default, { onRemove: (id) => removeStagedFile(id) });
	filePreviewApp.mount(host);
}
function renderFilePreview() {
	const preview = $("#file-preview");
	if (!preview) return;
	const staged = pendingFiles.value ?? [];
	mountFilePreview();
	preview.hidden = staged.length === 0;
	previewRows.value = staged.map(({ id, file }) => {
		let thumbUrl = null;
		if (file.type.startsWith("image/")) {
			thumbUrl = pendingThumbUrls.get(id) ?? null;
			if (!thumbUrl) {
				thumbUrl = URL.createObjectURL(file);
				pendingThumbUrls.set(id, thumbUrl);
			}
		}
		return {
			id,
			name: file.name,
			size: formatFileSize(file.size),
			thumbUrl
		};
	});
}
var CHUNK_THRESHOLD = 524288;
var CHUNK_SIZE = 524288;
async function uploadFile(file, caption) {
	if (!state.currentRoom) return;
	if (file.size > CHUNK_THRESHOLD) return uploadFileChunked(file, caption);
	const form = new FormData();
	form.append("file", file);
	if (caption) form.append("caption", caption);
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/upload?thread_id=${encodeURIComponent(state.currentThread)}`, {
			method: "POST",
			body: form
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			console.error("Upload failed:", err.error || res.statusText);
			appendSystem("Upload failed: " + (err.error || res.statusText));
		}
	} catch (err) {
		console.error("Upload error:", err);
		appendSystem("Upload failed: " + err?.message);
	}
}
async function uploadFileChunked(file, caption) {
	const uploadId = uuidv4();
	const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
	const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})…`);
	for (let i = 0; i < totalChunks; i++) {
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, file.size);
		const b64 = arrayBufferToBase64(await file.slice(start, end).arrayBuffer());
		const body = {
			uploadId,
			chunkIndex: i,
			totalChunks,
			filename: file.name,
			mime: file.type || "application/octet-stream",
			data: b64
		};
		if (i === totalChunks - 1 && caption) body.caption = caption;
		try {
			const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/upload/chunk?thread_id=${encodeURIComponent(state.currentThread)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				if (statusMsg) statusMsg.text = `Upload failed: ${err.error || res.statusText}`;
				return;
			}
		} catch (err) {
			if (statusMsg) statusMsg.text = `Upload failed: ${err?.message}`;
			return;
		}
		if (statusMsg) statusMsg.text = `Uploading ${file.name} (${i + 1}/${totalChunks})…`;
	}
	if (statusMsg) removeRow(statusMsg);
}
function openAttachPicker(cfg) {
	attachPickerCfg.value = cfg;
	$("#attach-picker-title").textContent = cfg.title;
	const search = $("#attach-picker-search");
	search.value = "";
	search.placeholder = cfg.searchPlaceholder || "Search…";
	const addBtn = $("#attach-picker-add-new");
	addBtn.hidden = !cfg.onAddNew;
	addBtn.textContent = cfg.addNewLabel || "+ Add new";
	renderAttachPickerList("");
	const picker = $("#attach-picker");
	picker.hidden = false;
	picker.offsetHeight;
	picker.classList.add("open");
	if (window.matchMedia("(min-width: 720px)").matches) setTimeout(() => search.focus(), 60);
}
function closeAttachPicker() {
	const picker = $("#attach-picker");
	picker.classList.remove("open");
	setTimeout(() => {
		picker.hidden = true;
	}, 220);
}
var attachPickerApp = null;
function mountAttachPicker() {
	if (attachPickerApp) return;
	const host = $("#attach-picker-list");
	if (!host) return;
	attachPickerApp = createApp(AttachPicker_default, { onToggle: async (key, attached, li) => {
		const cfg = attachPickerCfg.value;
		if (!cfg) return;
		const item = cfg.items().find((it) => String(cfg.name(it)) === key);
		if (!item) return;
		try {
			await cfg.onToggle(item, !attached);
		} catch (err) {
			showToast("Failed: " + (err?.message || err), { kind: "error" });
		}
		li.style.pointerEvents = "";
		renderAttachPickerList($("#attach-picker-search")?.value);
	} });
	attachPickerApp.mount(host);
}
function renderAttachPickerList(filterText) {
	const cfg = attachPickerCfg.value;
	mountAttachPicker();
	if (!cfg) {
		attachRows.value = [];
		attachEmptyText.value = "";
		return;
	}
	const q = (filterText || "").trim().toLowerCase();
	const items = cfg.items().filter((it) => !q || cfg.searchText(it).toLowerCase().includes(q));
	attachEmptyText.value = q ? `No matches for "${filterText}".` : cfg.emptyText || "Nothing to show.";
	attachRows.value = items.map((it) => ({
		key: String(cfg.name(it)),
		name: cfg.name(it),
		meta: cfg.meta ? cfg.meta(it) : "",
		attached: !!cfg.isAttached(it)
	}));
}
function wireFileControls1() {
	$("#import-any-btn")?.addEventListener("click", () => {
		const el = document.createElement("div");
		el.className = "import-note";
		el.textContent = "Pick a .tgz exported from NanoClaw — an agent bundle or a room bundle.";
		showConfirmModal({
			title: "Import from bundle",
			body: el,
			confirmLabel: "Choose file…"
		}).then((ok) => {
			if (ok) $("#import-any-file")?.click();
		});
	});
	$("#import-any-file")?.addEventListener("change", async (e) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		const tryUpload = async (endpoint) => {
			const fd = new FormData();
			fd.append("bundle", file);
			const res = await authFetch(endpoint, {
				method: "POST",
				body: fd
			});
			const body = await res.json().catch(() => ({}));
			return {
				ok: res.ok,
				body
			};
		};
		showToast("Uploading bundle…", { kind: "info" });
		let kind = "room";
		let up = await tryUpload("/api/rooms/import");
		if (!up.ok && /room export/i.test(up.body.error || "")) {
			kind = "agent";
			up = await tryUpload("/api/agents/import");
		}
		if (!up.ok) {
			showToast("Import failed: " + (up.body.error || "unrecognized bundle"), { kind: "error" });
			return;
		}
		if (kind === "room") return continueRoomImport(up.body);
		return continueAgentImport(up.body);
	});
}
function wireFileControls2() {
	$("#system-import-btn")?.addEventListener("click", () => $("#system-import-file")?.click());
	$("#system-import-file")?.addEventListener("change", async (e) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		showToast("Uploading backup…", { kind: "info" });
		let up;
		try {
			const fd = new FormData();
			fd.append("bundle", file);
			const res = await authFetch("/api/system/import", {
				method: "POST",
				body: fd
			});
			up = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(up.error || res.statusText);
		} catch (err) {
			showToast("Restore failed: " + (err?.message || err), { kind: "error" });
			return;
		}
		const m = up.preview.manifest;
		const el = document.createElement("div");
		const line = (t, cls) => {
			const d = document.createElement("div");
			if (cls) d.className = cls;
			d.textContent = t;
			el.appendChild(d);
		};
		line(`Backup from ${new Date(m.createdAt).toLocaleString()}${m.lean ? " (lean — no conversations)" : ""}`);
		line(`${m.counts.agents} agents · ${m.counts.rooms} rooms · ${m.counts.models} models · ${m.counts.mcpServers} MCP servers`);
		line("⚠ REPLACES everything on this install. Current state is kept aside as *.pre-restore-* for manual rollback.", "import-warning");
		line("The host restarts to finish the restore — the app will reconnect.", "import-note");
		if (!await showConfirmModal({
			title: "Restore this backup?",
			body: el,
			confirmLabel: "Restore and restart",
			destructive: true
		})) return;
		try {
			await apiJson("/api/system/import/apply", {
				method: "POST",
				body: { token: up.token }
			});
			showToast("Restoring — the host is restarting…", { kind: "info" });
		} catch (err) {
			showToast("Restore failed: " + (err?.message || err), { kind: "error" });
		}
	});
}
function wireFileControls3() {
	$("#file-picker")?.addEventListener("click", () => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.addEventListener("change", () => {
			if (input.files?.length && input.files.length > 0) stageFiles(input.files);
		});
		input.click();
	});
}
function uuidv4() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
	bytes[6] = bytes[6] & 15 | 64;
	bytes[8] = bytes[8] & 63 | 128;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function arrayBufferToBase64(buf) {
	const bytes = new Uint8Array(buf);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}
//#endregion
//#region src/features/slash-menu-state.ts
/** Commands matching what has been typed so far. */
var slashRows = ref([]);
/** Index of the highlighted row, moved by the composer's arrow keys. */
var slashActiveIndex = ref(0);
//#endregion
//#region src/features/SlashMenu.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$32 = ["onMousedown"];
var _hoisted_2$28 = { class: "slash-cmd" };
var _hoisted_3$24 = { class: "slash-desc" };
//#endregion
//#region src/features/SlashMenu.vue
var SlashMenu_default = /* @__PURE__ */ defineComponent({
	__name: "SlashMenu",
	props: { onPick: { type: Function } },
	setup(__props) {
		/**
		* The /command autocomplete — forty-eighth island.
		*
		* Mounted into <div id="slash-menu">, exclusively owned by this module. Its
		* hidden flag stays imperative: the menu is suppressed for non-admins entirely
		* (every one of these commands is admin-only — see command-gate.ts), and
		* whether to show it at all is a decision about the surface, not the rows.
		*
		* mousedown, NOT click, with preventDefault — the composer's blur would dismiss
		* the menu before a click could land, and preventing default keeps focus in the
		* input. Same reason MentionPopover uses it.
		*
		* esc() is gone: the imperative version built the row with innerHTML, so the
		* command and description had to be escaped by hand. Bindings escape by
		* construction.
		*/
		const props = __props;
		function pick(e, i) {
			e.preventDefault();
			props.onPick(i);
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(slashRows), (c, i) => {
				return openBlock(), createElementBlock("button", {
					key: c.cmd,
					type: "button",
					class: normalizeClass(i === unref(slashActiveIndex) ? "slash-item active" : "slash-item"),
					role: "option",
					onMousedown: ($event) => pick($event, i)
				}, [createElementVNode("span", _hoisted_2$28, toDisplayString(c.cmd), 1), createElementVNode("span", _hoisted_3$24, toDisplayString(c.desc), 1)], 42, _hoisted_1$32);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/composer.ts
var deps$14 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideComposerDeps(provided) {
	Object.assign(deps$14, provided);
}
var roomMentionPeople = [];
async function fetchMentionablePeople() {
	const roomId = state.currentRoom;
	if (!roomId) {
		roomMentionPeople = [];
		return;
	}
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId ?? "")}/mentionable`);
		if (!res.ok) return;
		const people = await res.json();
		if (state.currentRoom === roomId) roomMentionPeople = people.map((p) => ({
			folder: p.handle,
			name: p.name,
			isUser: true
		}));
	} catch {}
}
function tryActivateMention(input) {
	const seen = /* @__PURE__ */ new Set();
	const mentionPool = [];
	for (const a of [...getWiredAgentsForCurrentRoom(), ...roomMentionPeople]) {
		const key = (a.folder || "").toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		mentionPool.push(a);
	}
	if (mentionPool.length === 0) {
		dismissMentionPopover();
		return;
	}
	const value = input.value;
	const cursor = input.selectionStart ?? value.length;
	let i = cursor - 1;
	while (i >= 0) {
		const c = value[i];
		if (c === "@") {
			if (i !== 0 && !/\s/.test(value[i - 1])) {
				dismissMentionPopover();
				return;
			}
			break;
		}
		if (!/[a-zA-Z0-9-]/.test(c)) {
			dismissMentionPopover();
			return;
		}
		i--;
	}
	if (i < 0) {
		dismissMentionPopover();
		return;
	}
	setMentionStart(i);
	const token = value.slice(i + 1, cursor).toLowerCase();
	setMentionMatches(mentionPool.filter((a) => a.folder.toLowerCase().startsWith(token)).slice(0, 8));
	setMentionSelectedIndex(0);
	if (getMentionMatches().length === 0) {
		dismissMentionPopover();
		return;
	}
	renderMentionPopover(input);
}
function acceptMention(input) {
	if (getMentionStart() < 0 || getMentionMatches().length === 0) return;
	const agent = getMentionMatches()[getMentionSelectedIndex()];
	if (!agent) return;
	const before = input.value.slice(0, getMentionStart());
	const after = input.value.slice(input.selectionStart ?? input.value.length);
	const inserted = `@${agent.folder} `;
	input.value = before + inserted + after;
	const newCursor = before.length + inserted.length;
	input.setSelectionRange(newCursor, newCursor);
	dismissMentionPopover();
	input.dispatchEvent(new Event("input"));
}
function handleTypingEvent(msg) {
	if (msg.room_id !== state.currentRoom) return;
	const { identity, identity_type, is_typing } = msg;
	if (is_typing) {
		if (identity_type === "agent") state.agentName = identity;
		if (state.typingUsers.has(identity)) clearTimeout(state.typingUsers.get(identity).timeout);
		const timeout = setTimeout(() => {
			state.typingUsers.delete(identity);
			renderTypingIndicator();
		}, identity_type === "agent" ? 12e4 : 5e3);
		state.typingUsers.set(identity, {
			timeout,
			identity_type
		});
	} else {
		if (state.typingUsers.has(identity)) clearTimeout(state.typingUsers.get(identity).timeout);
		state.typingUsers.delete(identity);
	}
	renderTypingIndicator();
}
function renderTypingIndicator() {
	const el = $("#typing-indicator");
	const entries = [...state.typingUsers.entries()];
	const userTypers = entries.filter(([, v]) => v.identity_type !== "agent");
	const typingAgents = entries.filter(([, v]) => v.identity_type === "agent").map(([n]) => n);
	for (const name of typingAgents) ensureTurn(name);
	for (const t of [...thinkingTurns.value]) {
		if (t.statusLive) continue;
		if (typingAgents.includes(t.name)) continue;
		removeTurn(t.name);
	}
	if (userTypers.length > 0) {
		const names = userTypers.map(([n]) => esc(n));
		el.innerHTML = `${names.length === 1 ? `${names[0]} is typing` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing`}<span class="dots"><span></span><span></span><span></span></span>`;
		el.className = "typing-indicator is-visible";
		el.removeAttribute("aria-hidden");
	} else {
		el.classList.remove("is-visible");
		el.setAttribute("aria-hidden", "true");
	}
}
var SLASH_COMMANDS = [
	{
		cmd: "/clear",
		desc: "Reset this session — drop context, start fresh"
	},
	{
		cmd: "/clear all",
		desc: "Reset ALL of this agent's sessions (incl. background a2a)"
	},
	{
		cmd: "/compact",
		desc: "Compact the context now"
	},
	{
		cmd: "/compact all",
		desc: "Compact ALL of this agent's sessions"
	},
	{
		cmd: "/context",
		desc: "Show context-window usage"
	},
	{
		cmd: "/cost",
		desc: "Show token cost so far"
	},
	{
		cmd: "/files",
		desc: "List files in the workspace"
	},
	{
		cmd: "/learn",
		desc: "Distill a reusable skill from this session"
	}
];
var BULK_COMMANDS = {
	"/clear all": "/clear",
	"/compact all": "/compact"
};
var slashMatches = [];
var slashActive = 0;
var slashApp = null;
function mountSlashMenu() {
	if (slashApp) return;
	const host = $("#slash-menu");
	if (!host) return;
	slashApp = createApp(SlashMenu_default, { onPick: (i) => pickSlash(i) });
	slashApp.mount(host);
}
function updateSlashMenu() {
	const menu = $("#slash-menu");
	if (!menu) return;
	if (!isAdminView.value) {
		slashMatches = [];
		menu.hidden = true;
		return;
	}
	const input = $("#message-input");
	if (!input) return;
	const v = input.value;
	slashMatches = /^\/[a-z-]*( [a-z-]*)?$/i.exec(v) ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase())) : [];
	if (slashMatches.length === 0) {
		menu.hidden = true;
		return;
	}
	if (slashActive >= slashMatches.length) slashActive = 0;
	slashRows.value = slashMatches;
	slashActiveIndex.value = slashActive;
	mountSlashMenu();
	menu.hidden = false;
}
function pickSlash(i) {
	const c = slashMatches[i];
	if (!c) return;
	const input = $("#message-input");
	if (!input) return;
	slashMatches = [];
	const slashMenu = $("#slash-menu");
	if (slashMenu) slashMenu.hidden = true;
	const bulk = BULK_COMMANDS[c.cmd];
	if (bulk) {
		input.value = "";
		input.style.height = "auto";
		setTimeout(() => broadcastSessionCommand(bulk), 0);
		return;
	}
	input.value = c.cmd + " ";
	input.focus();
}
function slashKeydown(e) {
	if (slashMatches.length === 0) return false;
	if (e.key === "ArrowDown") {
		slashActive = (slashActive + 1) % slashMatches.length;
		updateSlashMenu();
		e.preventDefault();
		return true;
	}
	if (e.key === "ArrowUp") {
		slashActive = (slashActive - 1 + slashMatches.length) % slashMatches.length;
		updateSlashMenu();
		e.preventDefault();
		return true;
	}
	if (e.key === "Enter" || e.key === "Tab") {
		pickSlash(slashActive);
		e.preventDefault();
		return true;
	}
	if (e.key === "Escape") {
		slashMatches = [];
		const slashMenu = $("#slash-menu");
		if (slashMenu) slashMenu.hidden = true;
		e.preventDefault();
		return true;
	}
	return false;
}
var clientMsgSeq = 0;
function sendCurrentMessage() {
	const input = $("#message-input");
	if (!input) return;
	const text = input.value.trimEnd();
	if (!state.currentRoom) return;
	if (pendingFiles.value.length > 0) {
		const files = pendingFiles.value.map((p) => p.file);
		const caption = text;
		clearStagedFiles();
		input.value = "";
		input.style.height = "auto";
		(async () => {
			for (let i = 0; i < files.length; i++) await uploadFile(files[i], i === 0 ? caption : "");
		})();
		return;
	}
	if (!text) return;
	const bulk = BULK_COMMANDS[text.toLowerCase()];
	if (bulk) {
		input.value = "";
		input.style.height = "auto";
		const sm = $("#slash-menu");
		if (sm) sm.hidden = true;
		setTimeout(() => broadcastSessionCommand(bulk), 0);
		return;
	}
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
		showToast("Not connected — try again in a moment.", { kind: "error" });
		return;
	}
	const clientId = `local-${++clientMsgSeq}-${Date.now()}`;
	state.ws.send(JSON.stringify({
		type: "message",
		content: text,
		client_id: clientId,
		thread_id: state.currentThread
	}));
	const row = appendMessage({
		sender: state.myIdentity,
		sender_type: "user",
		content: text
	}, "✓");
	if (row) {
		row.roomId = state.currentRoom;
		row.threadId = state.currentThread;
		state.pendingMessages.set(clientId, row);
	}
	state.userScrolledAway = false;
	state.forceScrollCount = 3;
	clearUserScrollMarkers();
	scrollToBottom();
	input.value = "";
	input.style.height = "auto";
}
async function broadcastSessionCommand(command) {
	if (!state.currentRoom) return;
	const verb = command === "/clear" ? "Reset" : "Compact";
	if (!await showConfirmModal({
		title: `${verb} all sessions`,
		body: `${verb} every active session of this room's agent(s) — including background agent-to-agent sessions${command === "/clear" ? ". Each drops its context and starts fresh on the next turn." : "."}`,
		confirmLabel: verb,
		destructive: command === "/clear"
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/sessions/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command })
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		showToast(`${verb} queued for ${body.count} session(s)`, { kind: "success" });
	} catch (err) {
		showToast(`${verb} all failed: ${err.message}`, { kind: "error" });
	}
}
var wiredAgentsForCurrentRoom = [];
var mentionStart = -1;
var mentionMatches$1 = [];
var mentionSelectedIndex$1 = 0;
/** The composer's own wiring: form submit, keydown, and the mention menu. */
function wireComposer() {
	$("#message-form")?.addEventListener("submit", (e) => {
		e.preventDefault();
		sendCurrentMessage();
	});
	$("#message-input")?.addEventListener("keydown", (e) => {
		if (slashKeydown(e)) return;
		if (mentionMatches$1.length > 0 && (e.key === "Enter" || e.key === "Tab")) return;
		if (e.key !== "Enter") return;
		if (state.settings?.sendKey === "enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			sendCurrentMessage();
		}
		if (state.settings?.sendKey === "shift-enter" && e.shiftKey) {
			e.preventDefault();
			sendCurrentMessage();
		}
		if (state.settings?.sendKey === "ctrl-enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			sendCurrentMessage();
		}
	});
	const input = $("#message-input");
	if (!input) return;
	input.addEventListener("input", () => tryActivateMention(input));
	input.addEventListener("blur", () => {
		setTimeout(dismissMentionPopover, 120);
	});
	input.addEventListener("keydown", (e) => {
		if (mentionMatches$1.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			mentionSelectedIndex$1 = (mentionSelectedIndex$1 + 1) % mentionMatches$1.length;
			renderMentionPopover(input);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			mentionSelectedIndex$1 = (mentionSelectedIndex$1 - 1 + mentionMatches$1.length) % mentionMatches$1.length;
			renderMentionPopover(input);
		} else if (e.key === "Tab" || e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			acceptMention(input);
		} else if (e.key === "Escape") {
			e.preventDefault();
			dismissMentionPopover();
		}
	}, true);
}
function getWiredAgentsForCurrentRoom() {
	return wiredAgentsForCurrentRoom;
}
function setWiredAgentsForCurrentRoom(v) {
	wiredAgentsForCurrentRoom = v;
}
function getMentionStart() {
	return mentionStart;
}
function setMentionStart(v) {
	mentionStart = v;
}
function getMentionMatches() {
	return mentionMatches$1;
}
function setMentionMatches(v) {
	mentionMatches$1 = v;
}
function getMentionSelectedIndex() {
	return mentionSelectedIndex$1;
}
function setMentionSelectedIndex(v) {
	mentionSelectedIndex$1 = v;
}
//#endregion
//#region src/features/wizard-state.ts
/** Model names returned by the last successful Ollama probe. */
var wizardOllamaModels = ref([]);
/**
* The model whose radio is checked.
*
* State rather than a DOM write because two paths select one: the delegated
* change listener on the list, and the post-pull path, which used to find the
* radio with querySelector and set .checked on it directly.
*/
var wizardOllamaSelected = ref("");
//#endregion
//#region src/features/WizardOllamaModels.vue
var WizardOllamaModels_default = /* @__PURE__ */ defineComponent({
	__name: "WizardOllamaModels",
	setup(__props) {
		/**
		* The wizard's Ollama model radios — sixty-second island.
		*
		* Mounted into <ul id="wizard-ollama-list">, exclusively owned by this module.
		* Everything else wizardProbeOllama touches — the status line, the results and
		* download rows, the probe button's busy label — is SET on static markup and
		* stays imperative. Only the radio list was built.
		*
		* No @change here, deliberately. The listener is delegated on the HOST, which
		* Vue never replaces, so it keeps working across every render and the listener
		* set is unchanged by this conversion. Putting @change on each input would add
		* one listener per model and remove the host's — a diff for no gain.
		*
		* The checked radio is state because TWO paths select one: that delegated
		* listener, and the post-pull path, which used to find the input with
		* querySelector and assign .checked on it — an imperative write into what is
		* now Vue-owned DOM.
		*
		* Both `value` and `checked` are assigned as PROPERTIES through a function ref.
		* Only one of them had to be — measured, not assumed:
		*
		*   radio.value = v      → value="v"      REFLECTS
		*   radio.checked = true → no attribute   does not reflect
		*   text.value = v       → no attribute   does not reflect
		*   button.disabled      → disabled=""    REFLECTS
		*
		* `value` on a radio is in the IDL's "default" mode and reflects; on a text
		* input it is in "value" mode and does not. So :value would have been faithful
		* HERE and is the trap it has been elsewhere, which is exactly why it is not
		* worth reasoning about per element — assigning the property is faithful for
		* every one of these cases, so both go through the ref.
		*
		* That also settles `checked`: it does not reflect, so the earlier bindings in
		* #196, #217, #233 and #236 each bought an accepted markup difference that this
		* approach does not need. `disabled` in #242 reflects, so binding it was fine.
		*
		* The arrow is recreated each render, so Vue re-invokes it each render and the
		* properties follow the selection.
		*/
		function apply(el, m) {
			if (!el) return;
			el.value = m;
			el.checked = m === wizardOllamaSelected.value;
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(wizardOllamaModels), (m) => {
				return openBlock(), createElementBlock("li", { key: m }, [createElementVNode("label", null, [createElementVNode("input", {
					type: "radio",
					name: "wizard-ollama-model",
					ref_for: true,
					ref: (el) => apply(el, m)
				}, null, 512), createElementVNode("span", null, toDisplayString(m), 1)])]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/ollama-cards-state.ts
/** Configured hosts, in the order /api/ollama/hosts returned them. */
var hosts = ref([]);
/** host → its model list. Keyed by host because the fetches race. */
var hostModels = ref({});
/** host → its in-flight or last-finished pull. Absent means no line shown. */
var hostPulls = ref({});
/**
* host → what pulling the currently-typed ref would cost, or null for "say
* nothing". Null is the resting state and the honest answer whenever the size
* cannot be read; only a real measurement earns a line.
*/
var hostPullPreview = ref({});
/**
* Which cards are expanded.
*
* Backed by localStorage under `serverCardOpen:<host>`, the same keys the
* imperative accordion used — an operator's expanded cards survive this
* conversion. Held as a Set rather than read from storage during render so the
* template does not touch localStorage on every patch.
*/
var openCards = ref(/* @__PURE__ */ new Set());
function isCardOpen(host) {
	return localStorage.getItem("serverCardOpen:" + host) === "1";
}
function setCardOpen(host, open) {
	localStorage.setItem("serverCardOpen:" + host, open ? "1" : "0");
	const next = new Set(openCards.value);
	if (open) next.add(host);
	else next.delete(host);
	openCards.value = next;
}
/** Seed the open-set from storage for a freshly loaded host list. */
function syncOpenCards(list) {
	openCards.value = new Set(list.filter(isCardOpen));
}
//#endregion
//#region src/features/installers.ts
var deps$13 = {};
/** Wire the legacy helpers these runners call. Call once at startup. */
function provideInstallerDeps(provided) {
	Object.assign(deps$13, provided);
}
var CODEX_WIZARD_ELS = {
	btn: "#wizard-codex-install",
	log: "#wizard-codex-install-log",
	doneMsg: "Codex loaded — connect your credentials below."
};
async function runCodexInstall(els = CODEX_WIZARD_ELS) {
	const btn = $(els.btn);
	const log = $(els.log);
	if (!btn || codexInstallActive.value) return;
	codexInstallActive.value = true;
	const progress = els.progress ? $(els.progress) : null;
	if (progress) progress.hidden = false;
	log.hidden = false;
	log.textContent = "Installing…";
	let done = deps$13.wizardBusy(btn, "Installing…");
	const finish = () => {
		log.textContent = els.doneMsg || "Codex installed.";
		showToast("Codex installed", { kind: "success" });
	};
	try {
		const res = await authFetch("/api/codex/install", { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			log.textContent = "Install failed: " + (err.error || res.status);
			showToast(err.error || "Codex install failed", { kind: "error" });
			return;
		}
		let restarting = false;
		for (;;) {
			await new Promise((r) => setTimeout(r, 2500));
			let st;
			try {
				st = await (await authFetch("/api/codex/install")).json();
			} catch {
				restarting = true;
				break;
			}
			if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join("\n");
			if (st.installed) {
				finish();
				return;
			}
			if (!st.running && st.exitCode === 0) {
				restarting = true;
				break;
			}
			if (!st.running && st.exitCode != null && st.exitCode !== 0) {
				log.textContent = "Install failed — see log:\n" + (st.lines || []).slice(-14).join("\n");
				showToast("Codex install failed — see log", { kind: "error" });
				return;
			}
		}
		if (restarting) {
			done();
			done = deps$13.wizardBusy(btn, "Restarting…");
			log.textContent = "Restarting…";
			const deadline = Date.now() + 15e4;
			let sawResponsive = false;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2500));
				let st = null;
				try {
					st = await (await authFetch("/api/codex/install")).json();
					sawResponsive = true;
				} catch {
					st = null;
				}
				if (st?.installed) {
					finish();
					return;
				}
				if (Date.now() > deadline) {
					log.textContent = sawResponsive ? "Codex didn’t load — restart the service, then reopen setup." : "Server didn’t come back — restart it, then reopen setup.";
					showToast("Codex built — restart the server to finish", { kind: "error" });
					return;
				}
			}
		}
	} catch (err) {
		log.textContent = "Install error: " + err.message;
		showToast("Codex install error", { kind: "error" });
	} finally {
		done();
		codexInstallActive.value = false;
		deps$13.refreshWizardCredState();
		deps$13.renderCredentialsSettings();
	}
}
var OPENCODE_WIZARD_ELS = {
	btn: "#wizard-opencode-install",
	log: "#wizard-opencode-install-log",
	doneMsg: "OpenCode installed — your local agent can now use it (Agent → Harness)."
};
async function runOpencodeInstall(els = OPENCODE_WIZARD_ELS) {
	const url = els.url || "/api/opencode/install";
	const name = els.name || "OpenCode";
	const btn = $(els.btn);
	const log = $(els.log);
	if (!btn || opencodeInstallActive.value) return;
	opencodeInstallActive.value = true;
	deps$13.refreshWizardNextGate();
	const progress = els.progress ? $(els.progress) : null;
	if (progress) progress.hidden = false;
	log.hidden = false;
	log.textContent = "Installing…";
	let done = deps$13.wizardBusy(btn, "Installing…");
	const finish = () => {
		log.textContent = els.doneMsg || name + " installed.";
		showToast(name + " installed", { kind: "success" });
	};
	try {
		const res = await authFetch(url, { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (err.code === "already-installed") {
				finish();
				return;
			}
			log.textContent = "Install failed: " + (err.error || res.status);
			showToast(err.error || name + " install failed", { kind: "error" });
			return;
		}
		let restarting = false;
		for (;;) {
			await new Promise((r) => setTimeout(r, 2500));
			let st;
			try {
				st = await (await authFetch(url)).json();
			} catch {
				restarting = true;
				break;
			}
			if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-14).join("\n");
			if (st.installed) {
				finish();
				return;
			}
			if (!st.running && st.exitCode === 0) {
				restarting = true;
				break;
			}
			if (!st.running && st.exitCode != null && st.exitCode !== 0) {
				log.textContent = "Install failed — see log:\n" + (st.lines || []).slice(-14).join("\n");
				showToast(name + " install failed — see log", { kind: "error" });
				return;
			}
		}
		if (restarting) {
			done();
			done = deps$13.wizardBusy(btn, "Restarting…");
			log.textContent = "Restarting…";
			const deadline = Date.now() + 15e4;
			let sawResponsive = false;
			for (;;) {
				await new Promise((r) => setTimeout(r, 2500));
				let st = null;
				try {
					st = await (await authFetch(url)).json();
					sawResponsive = true;
				} catch {
					st = null;
				}
				if (st?.installed) {
					finish();
					return;
				}
				if (Date.now() > deadline) {
					log.textContent = sawResponsive ? "OpenCode didn’t load — restart the service, then reopen setup." : "Server didn’t come back — restart it, then reopen setup.";
					showToast(name + " built — restart the server to finish", { kind: "error" });
					return;
				}
			}
		}
	} catch (err) {
		log.textContent = "Install error: " + err.message;
		showToast(name + " install error", { kind: "error" });
	} finally {
		done();
		opencodeInstallActive.value = false;
		deps$13.refreshWizardNextGate();
		deps$13.renderWizardOpencodeInstall();
		deps$13.renderCredentialsSettings();
		deps$13.fetchAgents();
	}
}
var TTS_SETTINGS_ELS = {
	btn: "#tts-install-btn",
	log: "#tts-install-log",
	progress: "#tts-install-progress"
};
/**
* The shared install-poll loop.
*
* pollTtsInstall and pollSttInstall were the same 30 lines twice, differing in
* four values: the endpoint, which active-flag accessors to use, the two toast
* strings, and what to re-render afterwards. The duplication was not harmless —
* the TTS copy re-renders BOTH its surfaces (settings and wizard) because the
* shared active-guard means only one poll runs and it cannot rely on a single
* caller re-rendering; the STT copy does not, and it is not obvious from either
* one alone whether that is a deliberate difference or a missed edit.
*
* Making the difference a parameter answers that question in the call site.
*/
async function pollInstall(spec) {
	if (spec.isActive()) return;
	spec.setActive(true);
	const btn = $(spec.els.btn);
	const log = $(spec.els.log);
	const progress = $(spec.els.progress);
	if (progress) progress.hidden = false;
	if (btn) btn.disabled = true;
	try {
		for (;;) {
			const st = await (await authFetch(spec.endpoint)).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-12).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) {
					showToast(spec.successMsg, { kind: "success" });
					if (spec.onSuccess) await spec.onSuccess();
				} else showToast(spec.failMsg, { kind: "error" });
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast(spec.errPrefix + err?.message, { kind: "error" });
	} finally {
		spec.setActive(false);
		if (spec.onFinally) spec.onFinally();
	}
}
async function pollTtsInstall(els = TTS_SETTINGS_ELS) {
	await pollInstall({
		els,
		endpoint: "/api/webchat/tts/install",
		isActive: () => ttsInstallActive.value,
		setActive: (v) => ttsInstallActive.value = v,
		successMsg: "Read aloud installed — Kokoro voices are live",
		failMsg: "Read aloud install failed — see log",
		errPrefix: "Read aloud install error: ",
		onSuccess: () => loadTtsConfig(),
		onFinally: () => {
			deps$13.renderTtsSetupSettings();
			deps$13.renderWizardFeatures();
		}
	});
}
async function runTtsInstall(els = TTS_SETTINGS_ELS) {
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	const done = btn ? deps$13.wizardBusy(btn, "Installing…") : null;
	if (log) log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/webchat/tts/install", { method: "POST" });
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = "Install failed: " + (err.error || res.status);
			showToast("Read aloud install failed", { kind: "error" });
			done?.();
			return;
		}
		pollTtsInstall(els);
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		done?.();
	}
}
var STT_SETTINGS_ELS = {
	btn: "#stt-install-btn",
	log: "#stt-install-log",
	progress: "#stt-install-progress"
};
async function pollSttInstall(els = STT_SETTINGS_ELS, onDone) {
	await pollInstall({
		els,
		endpoint: "/api/webchat/stt/install",
		isActive: () => sttInstallActive.value,
		setActive: (v) => sttInstallActive.value = v,
		successMsg: "Voice dictation installed — the mic is live",
		failMsg: "Voice dictation install failed — see log",
		errPrefix: "Voice dictation install error: ",
		onSuccess: () => initSttFeature(),
		onFinally: () => {
			deps$13.renderSttSetupSettings();
			if (onDone) onDone();
		}
	});
}
async function runSttInstall(payload, els = STT_SETTINGS_ELS, onDone) {
	const btn = $(els.btn);
	const log = $(els.log);
	const progress = $(els.progress);
	if (progress) progress.hidden = false;
	const done = btn ? deps$13.wizardBusy(btn, "Installing…") : null;
	if (log) log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/webchat/stt/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = "Install failed: " + (err.error || res.status);
			showToast("Voice dictation install failed", { kind: "error" });
			done?.();
			return;
		}
		pollSttInstall(els, onDone);
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err.message;
		done?.();
	}
}
var ROUTING_ELS_SETTINGS = {
	log: "#routing-install-log",
	bar: "#routing-pull-bar",
	label: "#routing-pull-label"
};
/**
* The current step, read out of the installer's own output.
*
* Both install scripts share a marker vocabulary: `→ ` opens a step, `✓` and
* `✗` close one, `= ` is an aside. So the most recent line carrying one of
* those glyphs IS the current step — no parsing beyond a prefix match, and it
* degrades to '' rather than guessing when the output is something else.
*
* Deliberately NOT a percentage. The long pole in phase 1 is the docker image
* pull, whose only signal is per-layer byte counts from several concurrent
* layers, in a format that shifts between docker versions. A single number
* synthesised from that would be a guess wearing the costume of a measurement;
* the log underneath already shows the real bytes.
*/
function installStepLabel(lines) {
	if (!Array.isArray(lines)) return "";
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = String(lines[i] ?? "").trim();
		if (line.startsWith("✓") || line.startsWith("✗")) return line;
		if (line.startsWith("→")) return line.slice(1).trim();
	}
	return "";
}
function renderRoutingInstallProgress(st, els = ROUTING_ELS_SETTINGS) {
	const log = $(els.log);
	const bar = $(els.bar);
	const label = $(els.label);
	log.textContent = (st.lines || []).slice(-12).join("\n") || "Starting…";
	log.scrollTop = log.scrollHeight;
	const pull = st.pull;
	if (pull) {
		bar.hidden = false;
		label.hidden = false;
		const pct = pull.total > 0 ? Math.min(100, Math.round(100 * pull.completed / pull.total)) : 0;
		bar.querySelector("span").style.width = pct + "%";
		if (pull.status === "pulling") label.textContent = "Classifier model: " + (pull.detail || "downloading…") + " (" + pct + "%)";
		else if (pull.status === "success") label.textContent = "Classifier model ready.";
		else label.textContent = "Classifier model pull failed: " + (pull.error || "");
	} else {
		bar.hidden = true;
		const step = installStepLabel(st.lines);
		label.hidden = !step;
		if (step) label.textContent = step;
	}
}
async function pollRoutingInstall() {
	if (routingInstallActive.value) return;
	routingInstallActive.value = true;
	const btn = $("#routing-install-btn");
	$("#routing-install-progress").hidden = false;
	btn.disabled = true;
	let chainHandled = false;
	try {
		while (true) {
			const st = await (await authFetch("/api/router/install")).json();
			renderRoutingInstallProgress(st);
			if (!st.running && !chainHandled) {
				chainHandled = true;
				if (st.exitCode === 0) {
					try {
						await authFetch("/api/router/routes", {
							method: "PUT",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ live: { enabled: true } })
						});
					} catch {}
					await deps$13.fetchModels();
					showToast("Auto routing installed and live — assign the “auto” model to an agent.", { kind: "success" });
					await deps$13.probeRoutingAvailability();
				} else {
					showToast("Auto routing setup failed — see log", { kind: "error" });
					break;
				}
			}
			const pullDone = !st.pull || st.pull.status !== "pulling";
			if (!st.running && pullDone) break;
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Auto routing setup error: " + err.message, { kind: "error" });
	} finally {
		routingInstallActive.value = false;
		deps$13.renderRoutingSetup();
	}
}
async function installLitellmPhase(els = ROUTING_ELS_SETTINGS) {
	const log = $(els.log);
	const label = $(els.label);
	const setStep = (text) => {
		label.hidden = !text;
		if (text) label.textContent = text;
	};
	log.textContent = "Installing the LiteLLM router…";
	setStep("Installing the LiteLLM router…");
	let res;
	try {
		res = await authFetch("/api/router/litellm-install", { method: "POST" });
	} catch (err) {
		log.textContent = "LiteLLM install failed: " + err.message;
		setStep("✗ LiteLLM install failed");
		showToast("LiteLLM install failed", { kind: "error" });
		return false;
	}
	if (!res.ok && res.status !== 202) {
		log.textContent = "LiteLLM install failed: " + ((await res.json().catch(() => ({}))).error || res.status);
		setStep("✗ LiteLLM install failed");
		showToast("LiteLLM install failed", { kind: "error" });
		return false;
	}
	while (true) {
		const st = await (await authFetch("/api/router/litellm-install")).json();
		if (Array.isArray(st.lines) && st.lines.length) log.textContent = st.lines.slice(-12).join("\n");
		const step = installStepLabel(st.lines);
		if (step) setStep(step);
		if (!st.running) {
			if (st.exitCode === 0) {
				showToast("LiteLLM router installed", { kind: "success" });
				return true;
			}
			showToast("LiteLLM install failed — see log", { kind: "error" });
			return false;
		}
		await new Promise((r) => setTimeout(r, 2e3));
	}
}
async function runRoutingInstall() {
	const btn = $("#routing-install-btn");
	const log = $("#routing-install-log");
	$("#routing-install-progress").hidden = false;
	btn.disabled = true;
	btn.textContent = "Installing…";
	log.textContent = "Starting…";
	try {
		if (!(await (await authFetch("/api/router/install")).json().catch(() => ({}))).litellmReady) {
			if (!await installLitellmPhase(ROUTING_ELS_SETTINGS)) {
				btn.disabled = false;
				btn.textContent = "Install";
				return;
			}
		}
		const res = await authFetch("/api/router/install", { method: "POST" });
		if (!res.ok) {
			log.textContent = "Install failed: " + ((await res.json().catch(() => ({}))).error || res.status);
			showToast("Auto routing setup failed", { kind: "error" });
			btn.disabled = false;
			btn.textContent = "Install";
			return;
		}
		pollRoutingInstall();
	} catch (err) {
		log.textContent = "Install failed: " + err.message;
		showToast("Auto routing setup failed", { kind: "error" });
		btn.disabled = false;
		btn.textContent = "Install";
	}
}
/** Debounce handles for the live pull preview, one per host. */
var previewTimers = {};
/**
* What pulling the currently-typed ref would cost, shown UNDER the box as it
* is typed.
*
* This replaced a confirm dialog. The dialog opened centre-screen while the
* card it described sat in a corner, dimmed the pane behind it, and put its
* loudest button on "Pull" directly beneath a warning advising against
* pulling. Worse, it asked a question whose answer was already computable:
* size and VRAM fit are known the moment the ref is typed, so making someone
* click, read and click again bought nothing. Now the cost is simply visible
* while they decide, and the click that starts the pull is the only click.
*
* Silence is a valid answer. A ref whose size cannot be read — private
* registry, registry unreachable — clears the line rather than announcing its
* own ignorance, and any failure here leaves the pull entirely unaffected.
*/
function previewOllamaPull(host, model) {
	clearTimeout(previewTimers[host]);
	const ref = (model || "").trim();
	if (!ref) {
		hostPullPreview.value = {
			...hostPullPreview.value,
			[host]: null
		};
		return;
	}
	previewTimers[host] = setTimeout(async () => {
		try {
			const pre = await (await authFetch("/api/ollama/prepull?model=" + encodeURIComponent(ref))).json();
			if (pre.sizeBytes == null) {
				hostPullPreview.value = {
					...hostPullPreview.value,
					[host]: null
				};
				return;
			}
			const parts = [`${mmFmtGB(pre.sizeBytes)} download`];
			if (pre.vramFit === "fits") parts.push(`✓ should fit in VRAM (~${mmFmtGB(pre.estFootprintBytes)} est.)`);
			else if (pre.vramFit === "spills") parts.push(`⚠ likely spills to CPU (~${mmFmtGB(pre.estFootprintBytes)} est.) — slow`);
			hostPullPreview.value = {
				...hostPullPreview.value,
				[host]: {
					model: ref,
					text: parts.join(" · "),
					warn: pre.vramFit === "spills"
				}
			};
		} catch {
			hostPullPreview.value = {
				...hostPullPreview.value,
				[host]: null
			};
		}
	}, 400);
}
/** Stop a pull that is already running. */
async function cancelOllamaPull(host, model) {
	try {
		if (!(await authFetch("/api/ollama/pull/cancel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				host,
				model
			})
		})).ok) return;
	} catch {}
}
async function startOllamaPull(host, model, input, btn) {
	if (!model) return;
	btn.disabled = true;
	clearTimeout(previewTimers[host]);
	hostPullPreview.value = {
		...hostPullPreview.value,
		[host]: null
	};
	try {
		const res = await authFetch("/api/ollama/pull", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				host,
				model
			})
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		input.value = "";
		pollOllamaPulls();
	} catch (err) {
		showToast("Pull failed to start: " + err.message, { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
/** One-model fitness verdict, attached to the host card's pull status. */
async function attachPullVerdict(host, model) {
	try {
		const r = await authFetch("/api/models/manage");
		if (!r.ok) return;
		const inv = await r.json();
		const tag = String(model).toLowerCase();
		const m = (inv.models || []).find((x) => String(x.tag).toLowerCase().startsWith(tag));
		if (!m) return;
		const lines = [];
		const spec = [
			m.paramSize,
			m.quant,
			m.sizeBytes ? mmFmtGB(m.sizeBytes) : null
		].filter(Boolean).join(" · ");
		if (spec) lines.push(spec);
		const ctxTxt = `context ${Math.round(m.configuredCtx / 1024)}k${m.maxContext ? ` of ${Math.round(m.maxContext / 1024)}k max` : ""}`;
		lines.push(m.fit?.context === "fits" ? `✓ ${ctxTxt} — agent prompt fits` : `⚠ ${ctxTxt} — agent prompt truncates`);
		if (m.fit?.vram !== "unknown") lines.push(m.fit?.vram === "fits" ? `✓ VRAM fits (~${mmFmtGB(m.fit.estFootprintBytes)} est.)` : `⚠ spills to CPU (~${mmFmtGB(m.fit.estFootprintBytes)} est.) — slow`);
		const entry = hostPulls.value[host];
		if (entry && entry.model === model) hostPulls.value = {
			...hostPulls.value,
			[host]: {
				...entry,
				verdict: lines
			}
		};
	} catch {}
}
function renderOllamaPulls(pulls) {
	for (const job of pulls) {
		const pct = job.total > 0 ? Math.min(100, Math.round(100 * job.completed / job.total)) : 0;
		const prev = hostPulls.value[job.host];
		hostPulls.value[job.host] = {
			status: job.status,
			model: job.model,
			detail: job.detail,
			error: job.error || "",
			pct,
			verdict: prev && prev.model === job.model ? prev.verdict : void 0
		};
		if (job.status !== "pulling" && !pullsDone.has(job.host + "\0" + job.model)) {
			pullsDone.add(job.host + "\0" + job.model);
			if (job.status === "cancelled") showToast("Cancelled pull of " + job.model);
			if (job.status === "success") {
				showToast("Pulled " + job.model, { kind: "success" });
				deps$13.loadOllamaHostModels(job.host);
				attachPullVerdict(job.host, job.model);
			}
		}
	}
}
/**
* host\0model pairs whose finish has already been announced.
*
* Was a data-* attribute on the status box (`done_<model>`), which only worked
* because that element survived between polls. The element is a vnode now, so
* the bookkeeping lives beside the state it guards — and a dataset key built by
* concatenating a model name was one dot away from colliding anyway.
*/
var pullsDone = /* @__PURE__ */ new Set();
async function pollOllamaPulls() {
	if (ollamaPullPoller.value) return;
	const tick = async () => {
		try {
			const res = await authFetch("/api/ollama/pulls");
			if (!res.ok) throw new Error(String(res.status));
			const { pulls } = await res.json();
			renderOllamaPulls(pulls);
			if (pulls.some((p) => p.status === "pulling")) ollamaPullPoller.value = setTimeout(tick, 1500);
			else ollamaPullPoller.value = null;
		} catch {
			ollamaPullPoller.value = null;
		}
	};
	ollamaPullPoller.value = setTimeout(tick, 0);
}
//#endregion
//#region src/features/wizard.ts
var deps$12 = {};
/** Wire the legacy helpers this module calls. Call once, before the wizard opens. */
function provideWizardDeps(provided) {
	Object.assign(deps$12, provided);
}
var wizardBtnWired = false;
async function renderSettingsWizardButton() {
	const wizardSection = $("#settings-wizard");
	if (!wizardSection) return;
	let ok = false;
	try {
		ok = (await authFetch("/api/workspace-credential")).ok;
	} catch {
		ok = false;
	}
	wizardSection.hidden = !ok;
	if (!ok || wizardBtnWired) return;
	wizardBtnWired = true;
	$("#wizard-open-btn")?.addEventListener("click", () => {
		deps$12.closeSettings();
		openWizard();
	});
}
var WIZARD_STEPS = 3;
var wizardStep = 0;
var wizardWired = false;
var wizardOllamaProbe = null;
var wizardEngine = "claude";
var wizardCodexAvailable = false;
var wizardCred = null;
async function renderWizardOpencodeInstall() {
	const row = $("#wizard-opencode-install-row");
	const hint = $("#wizard-opencode-hint");
	if (!row) return;
	if (!!($("#wizard-ollama-connected")?.hidden ?? true)) {
		row.hidden = true;
		if (hint) hint.hidden = true;
		return;
	}
	let installed = false;
	let running = false;
	try {
		const st = await (await authFetch("/api/opencode/install")).json();
		installed = !!st.installed;
		running = !!st.running;
	} catch {}
	const badge = $("#wizard-opencode-installed-badge");
	const btn = $("#wizard-opencode-install");
	row.hidden = false;
	if (hint) hint.hidden = installed;
	if (badge) badge.hidden = !installed;
	if (btn && !opencodeInstallActive.value) btn.hidden = installed;
	opencodeGateFromServer.value = running;
	refreshWizardNextGate();
	if (running) {
		clearTimeout(opencodeGatePoll.value ?? void 0);
		opencodeGatePoll.value = setTimeout(renderWizardOpencodeInstall, 3e3);
	}
}
function buildWizardDots() {
	const dots = $("#wizard-dots");
	if (!dots) return;
	dots.innerHTML = "";
	for (let i = 0; i < WIZARD_STEPS; i++) {
		const d = document.createElement("span");
		d.className = "wizard-dot";
		dots.appendChild(d);
	}
}
async function refreshWizardCredState() {
	let s;
	try {
		const r = await authFetch("/api/workspace-credential");
		if (!r.ok) return;
		s = await r.json();
	} catch {
		return;
	}
	wizardCred = s;
	wizardCodexAvailable = !!s.codexAvailable;
	const credWord = (t) => t === "oauth_token" ? "subscription" : "API key";
	const claudeChip = $("#wizard-chip-claude");
	if (claudeChip) {
		claudeChip.hidden = false;
		claudeChip.textContent = s.connected ? "✓ connected" : "not connected";
		claudeChip.classList.toggle("ok", !!s.connected);
	}
	$("#wizard-claude-connect").hidden = !!s.connected;
	$("#wizard-claude-connected").hidden = !s.connected;
	if (s.connected) $("#wizard-claude-connected-text").textContent = s.external ? "Claude connected" : `Claude connected — ${credWord(s.credType)}`;
	$("#wizard-claude-disconnect").hidden = !!s.external;
	const codexChip = $("#wizard-chip-codex");
	if (codexChip) {
		codexChip.hidden = false;
		codexChip.textContent = s.codex?.connected ? "✓ connected" : wizardCodexAvailable ? "not connected" : "not installed";
		codexChip.classList.toggle("ok", !!s.codex?.connected);
	}
	const codexInstallRow = $("#wizard-codex-install-row");
	if (codexInstallRow && !codexInstallActive.value) codexInstallRow.hidden = wizardCodexAvailable;
	$("#wizard-codex-connect").hidden = !wizardCodexAvailable || !!s.codex?.connected;
	$("#wizard-codex-connected").hidden = !s.codex?.connected;
	if (s.codex?.connected) $("#wizard-codex-connected-text").textContent = s.codex.external ? "Codex connected" : `Codex connected — ${credWord(s.codex.credType)}`;
	const codexDisconnect = $("#wizard-codex-disconnect");
	if (codexDisconnect) codexDisconnect.hidden = !!s.codex?.external;
	const ollamaSet = s.defaultModelKind === "ollama" && !!s.defaultModelId;
	const ollamaModel = s.defaultModelModelId || s.defaultModelName;
	const ollamaChip = $("#wizard-chip-ollama");
	if (ollamaChip) {
		ollamaChip.hidden = false;
		ollamaChip.textContent = ollamaSet ? `✓ ${ollamaModel}` : "no model";
		ollamaChip.classList.toggle("ok", ollamaSet);
	}
	const ollamaCard = $("#wizard-ollama-connected");
	const ollamaSetup = $("#wizard-ollama-setup");
	if (ollamaCard && ollamaSetup) {
		ollamaCard.hidden = !ollamaSet;
		ollamaSetup.hidden = ollamaSet;
		if (ollamaSet) $("#wizard-ollama-connected-text").textContent = `${ollamaModel} · default`;
	}
	renderWizardOpencodeInstall();
}
async function wizardCheckLocalOllama() {
	try {
		const r = await authFetch("/api/ollama/local");
		if (!r.ok) return;
		const st = await r.json();
		if (st.reachable) {
			const url = $("#wizard-ollama-url");
			if (url && !url.value) url.value = "http://localhost:11434";
			$("#wizard-ollama-install-row").hidden = true;
			$("#wizard-ollama-dl-row").hidden = false;
			wizardLoadRecommendation();
			wizardReattachPull();
		} else $("#wizard-ollama-install-row").hidden = !st.canInstall;
	} catch {}
}
async function wizardFollowPull(host, model) {
	const btn = $("#wizard-ollama-dl");
	const bar = $("#wizard-ollama-pull-bar");
	const done = wizardBusy(btn, "Downloading…");
	bar.hidden = false;
	try {
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const { pulls } = await (await authFetch("/api/ollama/pulls")).json();
			const job = (pulls || []).find((j) => j.model === model && j.host === host);
			if (!job) continue;
			const pct = job.total > 0 ? Math.round(job.completed / job.total * 100) : 0;
			bar.querySelector("span").style.width = pct + "%";
			wizardSetStatus("#wizard-ollama-dl-status", `${job.detail || "downloading…"} (${pct}%)`, null);
			if (job.status === "success") {
				bar.hidden = true;
				wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded — setting it as the default…`, "ok");
				const probed = await wizardProbeOllama();
				if (probed && (probed.models || []).some((m) => String(m) === model)) {
					wizardOllamaSelected.value = model;
					await wizardSelectOllamaModel(model);
					wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded and set as the workspace default.`, "ok");
				} else wizardSetStatus("#wizard-ollama-dl-status", `${model} downloaded — pick it above to set the default.`, "ok");
				return;
			}
			if (job.status === "error") {
				bar.hidden = true;
				return wizardSetStatus("#wizard-ollama-dl-status", job.error || "Pull failed.", "err");
			}
		}
	} finally {
		done();
	}
}
var wizardOllamaApp = null;
function mountWizardOllamaModels() {
	if (wizardOllamaApp) return;
	const host = $("#wizard-ollama-list");
	if (!host) return;
	wizardOllamaApp = createApp(WizardOllamaModels_default);
	wizardOllamaApp.mount(host);
}
async function wizardProbeOllama() {
	const url = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
	const done = wizardBusy($("#wizard-ollama-probe"), "Probing…");
	$("#wizard-ollama-status").hidden = true;
	try {
		const r = await authFetch("/api/models/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) {
			wizardSetStatus("#wizard-ollama-status", body.error || `Probe failed (${r.status}).`, "err");
			return null;
		}
		if (!body.kind || !(body.models || []).length) {
			wizardSetStatus("#wizard-ollama-status", body.reason || "No models found at that endpoint.", "err");
			return null;
		}
		wizardOllamaProbe = body;
		wizardOllamaModels.value = body.models.map((m) => String(m));
		mountWizardOllamaModels();
		$("#wizard-ollama-results").hidden = false;
		$("#wizard-ollama-dl-row").hidden = false;
		wizardLoadRecommendation();
		const n = wizardOllamaModels.value.length;
		wizardSetStatus("#wizard-ollama-status", `Found ${n} model${n === 1 ? "" : "s"} at ${body.endpoint || url}`, "ok");
		await nextTick();
		$("#wizard-ollama-results")?.scrollIntoView({
			block: "nearest",
			behavior: "smooth"
		});
		return body;
	} finally {
		done();
	}
}
async function wizardSelectOllamaModel(modelId) {
	if (!wizardOllamaProbe || !modelId) return;
	const endpoint = String(wizardOllamaProbe.endpoint || "").replace(/\/+$/, "");
	const host = (() => {
		try {
			return new URL(wizardOllamaProbe.endpoint).host;
		} catch {
			return wizardOllamaProbe.endpoint;
		}
	})();
	wizardSetStatus("#wizard-ollama-status", `Setting ${modelId} as the default…`, null);
	try {
		let id = null;
		try {
			const roster = await (await authFetch("/api/models")).json();
			id = (Array.isArray(roster) ? roster : []).find((m) => m.kind === "ollama" && String(m.endpoint || "").replace(/\/+$/, "") === endpoint && m.model_id === modelId)?.id ?? null;
		} catch {}
		if (!id) {
			const r = await authFetch("/api/models/bulk", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ models: [{
					name: `${host} · ${modelId}`,
					kind: wizardOllamaProbe.kind,
					endpoint: wizardOllamaProbe.endpoint,
					model_id: modelId
				}] })
			});
			const out = await r.json().catch(() => ({}));
			const created = out.created?.[0];
			if (!r.ok || !created) {
				wizardSetStatus("#wizard-ollama-status", out.error || out.failed?.[0]?.error || "Add failed.", "err");
				return;
			}
			id = created.id;
		}
		const dr = await authFetch("/api/workspace-model", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: id })
		});
		if (!dr.ok) {
			wizardSetStatus("#wizard-ollama-status", "Setting the default failed: " + ((await dr.json().catch(() => ({}))).error || dr.statusText), "err");
			return;
		}
		$("#wizard-ollama-status").hidden = true;
		await refreshWizardCredState();
	} catch {
		wizardSetStatus("#wizard-ollama-status", "Setting the default failed.", "err");
	}
}
async function wizardClearOllamaDefault() {
	if (wizardCred?.defaultModelKind !== "ollama" || !wizardCred?.defaultModelId) return;
	try {
		await authFetch("/api/workspace-model", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: null })
		});
		await refreshWizardCredState();
	} catch {}
}
var wizardRecLoaded = false;
async function wizardLoadRecommendation() {
	if (wizardRecLoaded) return;
	const hint = $("#wizard-ollama-rec");
	const input = $("#wizard-ollama-dl-model");
	try {
		const r = await authFetch("/api/ollama/recommend");
		if (!r.ok) return;
		const { recommendation: rec, remoteOllama } = await r.json();
		wizardRecLoaded = true;
		if (input && !input.value) input.value = rec.model.id;
		if (hint) {
			const remote = remoteOllama?.present === true;
			const fit = remote ? "remote Ollama" : rec.tight ? "tight fit" : rec.basis === "gpu" ? "GPU" : "good fit";
			hint.hidden = false;
			hint.textContent = `Recommended: ${rec.model.id} · ${fit}`;
			hint.title = remote ? `Runs on your remote Ollama (${remoteOllama.endpoint}). ${rec.detected}` : rec.detected;
			hint.classList.toggle("err", !remote && !!rec.tight);
		}
	} catch {
		if (input && !input.value) input.value = "qwen3:1.7b";
	}
}
async function wizardReattachPull() {
	try {
		const host = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
		const { pulls } = await (await authFetch("/api/ollama/pulls")).json();
		const job = (pulls || []).find((j) => j.host === host && j.status === "pulling");
		if (!job) return;
		$("#wizard-ollama-dl-model").value = job.model;
		await wizardFollowPull(host, job.model);
	} catch {}
}
function syncWizardEngineBodies() {
	document.querySelectorAll(".wizard-engine-body").forEach((b) => {
		b.hidden = b.dataset.engine !== wizardEngine;
	});
}
function wizardEngineConnected() {
	const s = wizardCred || {};
	if (wizardEngine === "codex") return !!s.codex?.connected;
	if (wizardEngine === "ollama") return !!s.defaultModelId;
	return !!s.connected;
}
function showWizardStep(i) {
	wizardStep = Math.max(0, Math.min(2, i));
	document.querySelectorAll(".wizard-step").forEach((s) => {
		const step = s;
		step.hidden = Number(step.dataset.step) !== wizardStep;
	});
	if (wizardStep === 0) syncWizardEngineBodies();
	if (wizardStep === 1) renderWizardAccess();
	if (wizardStep === 2) renderWizardFeatures();
	document.querySelectorAll("#wizard-dots .wizard-dot").forEach((d, idx) => {
		d.classList.toggle("active", idx === wizardStep);
		d.classList.toggle("done", idx < wizardStep);
	});
	$("#wizard-back").hidden = wizardStep === 0;
	const isLast = wizardStep === 2;
	$("#wizard-next").textContent = isLast ? "Finish" : "Next";
	refreshWizardNextGate();
}
function refreshWizardNextGate() {
	const btn = $("#wizard-next");
	if (!btn) return;
	if (opencodeInstallActive.value || opencodeGateFromServer.value) {
		btn.disabled = true;
		btn.dataset.gated = "1";
		btn.textContent = "Installing OpenCode…";
		btn.title = "Hang tight — finishing now would interrupt your first message when the harness restarts.";
	} else if (btn.dataset.gated) {
		delete btn.dataset.gated;
		btn.disabled = false;
		btn.title = "";
		btn.textContent = wizardStep === 2 ? "Finish" : "Next";
	}
}
async function openWizard() {
	wireWizard();
	buildWizardDots();
	showWizardStep(0);
	await refreshWizardCredState();
	$("#wizard-overlay").hidden = false;
}
function closeWizard() {
	$("#wizard-overlay").hidden = true;
}
async function finishWizard() {
	try {
		await authFetch("/api/webchat/onboarding", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ complete: true })
		});
	} catch {}
	wizardStopTsPoll();
	closeWizard();
}
function wizardBusy(btn, busyLabel) {
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = "";
	const spin = document.createElement("span");
	spin.className = "btn-spinner";
	spin.setAttribute("aria-hidden", "true");
	btn.appendChild(spin);
	btn.appendChild(document.createTextNode(busyLabel));
	return () => {
		btn.disabled = false;
		btn.textContent = original;
	};
}
function wizardSetStatus(id, text, kind) {
	const el = $(id);
	if (!el) return;
	el.hidden = false;
	el.textContent = text;
	el.classList.toggle("ok", kind === "ok");
	el.classList.toggle("err", kind === "err");
}
async function wizardProbeHttps() {
	const row = $("#wizard-https-row");
	if (!row) return;
	let state = null;
	try {
		const r = await authFetch("/api/webchat/tailscale-https");
		if (r.ok) state = await r.json();
	} catch {
		state = null;
	}
	if (state && state.available && !state.active) {
		row.hidden = false;
		wizardSetStatus("#wizard-https-status", "", null);
		$("#wizard-https-status").hidden = true;
	} else if (state && state.active) {
		row.hidden = false;
		$("#wizard-https-btn").hidden = true;
		wizardSetStatus("#wizard-https-status", "HTTPS is already on.", "ok");
	} else row.hidden = true;
}
async function wizardEnableHttps() {
	const btn = $("#wizard-https-btn");
	btn.disabled = true;
	const restore = btn.textContent;
	btn.textContent = "Enabling…";
	try {
		const r = await authFetch("/api/webchat/tailscale-https", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok && data.ok) {
			btn.hidden = true;
			wizardSetStatus("#wizard-https-status", data.url ? `HTTPS on — reach this at ${data.url}` : "HTTPS enabled.", "ok");
			showToast("HTTPS enabled over Tailscale", { kind: "success" });
		} else {
			const msg = [data.error, data.hint].filter(Boolean).join(" ") || "Could not enable HTTPS";
			wizardSetStatus("#wizard-https-status", msg, "err");
			if (data.hintUrl) {
				const el = $("#wizard-https-status");
				el.innerHTML = `${esc(msg)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>`;
			}
			showToast(data.error || "Could not enable HTTPS", {
				kind: "error",
				timeout: 9e3
			});
		}
	} catch {
		wizardSetStatus("#wizard-https-status", "Connection failed.", "err");
	} finally {
		btn.disabled = false;
		if (!btn.hidden) btn.textContent = restore;
	}
}
function syncWizardAccessBodies() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value || "bearer";
	document.querySelectorAll(".wizard-engine-body[data-access]").forEach((b) => {
		b.hidden = b.dataset.access !== sel;
	});
	if (sel === "tailscale") wizardProbeHttps();
	wizardStartTsPollIfNeeded();
}
var wizardTtsWired = false;
var WIZARD_TTS_ELS = {
	btn: "#wizard-tts-install",
	log: "#wizard-tts-log",
	progress: "#wizard-tts-progress"
};
var wizardSttWired = false;
var wizardSttBackend = "local";
var WIZARD_STT_ELS = {
	btn: "#wizard-stt-install",
	log: "#wizard-stt-log",
	progress: "#wizard-stt-log"
};
async function renderWizardDictation() {
	const section = $("#wizard-stt-section");
	if (!section) return;
	let st = null;
	try {
		const r = await authFetch("/api/webchat/stt/install");
		if (r.ok) st = await r.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	const enable = $("#wizard-stt-enable");
	if (enable) enable.checked = !!st.enabled;
	if (!wizardSttWired) {
		wizardSttWired = true;
		enable?.addEventListener("change", async () => {
			const on = enable.checked;
			if (!(await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: on })
			})).ok) {
				enable.checked = !on;
				showToast("Could not update voice dictation", { kind: "error" });
				return;
			}
			renderWizardDictation();
		});
		document.querySelectorAll("#wizard-stt-backend input[type=\"radio\"]").forEach((b) => {
			b.addEventListener("change", () => {
				if (!b.checked) return;
				wizardSttBackend = b.value;
				renderWizardDictation();
			});
		});
		$("#wizard-stt-install")?.addEventListener("click", () => runSttInstall({ provider: "local" }, WIZARD_STT_ELS, renderWizardDictation));
		$("#wizard-stt-connect")?.addEventListener("click", () => {
			const key = ($("#wizard-stt-key")?.value || "").trim();
			if (!key) {
				showToast("Enter the ElevenLabs API key first", { kind: "error" });
				return;
			}
			runSttInstall({
				provider: "elevenlabs",
				apiKey: key
			}, WIZARD_STT_ELS, renderWizardDictation);
			$("#wizard-stt-key").value = "";
		});
	}
	const group = $("#wizard-stt-group");
	if (group) group.hidden = !st.enabled;
	if (!st.enabled) return;
	const installed = !!st.installed;
	const backend = installed ? st.provider || wizardSttBackend : wizardSttBackend;
	document.querySelectorAll("#wizard-stt-backend input[type=\"radio\"]").forEach((b) => {
		b.checked = b.value === backend;
	});
	const local = backend === "local";
	const badge = $("#wizard-stt-installed");
	if (badge) badge.hidden = !installed;
	const badgeText = $("#wizard-stt-installed-text");
	if (badgeText) badgeText.textContent = local ? "Whisper installed" : "ElevenLabs connected";
	const installRow = $("#wizard-stt-install-row");
	if (installRow) installRow.hidden = installed || !local || !st.installerPresent;
	const keyRow = $("#wizard-stt-key-row");
	if (keyRow) keyRow.hidden = installed || local;
	if (st.running) pollSttInstall(WIZARD_STT_ELS, renderWizardDictation);
}
async function renderWizardFeatures() {
	renderWizardDictation();
	const mkt = $("#wizard-marketplace");
	if (mkt) mkt.checked = state.marketplaceEnabled === true;
	const ttsDefault = $("#wizard-tts-default");
	if (ttsDefault) ttsDefault.checked = getTtsReadAloudEnabled();
	if (!wizardTtsWired) {
		wizardTtsWired = true;
		ttsDefault?.addEventListener("change", async () => {
			const on = ttsDefault.checked;
			try {
				if (!(await authFetch("/api/tts/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ readAloud: on })
				})).ok) throw new Error("save failed");
				setTtsReadAloudEnabled(on);
				if (!on) stopTts();
				renderWizardFeatures();
			} catch {
				ttsDefault.checked = !on;
				showToast("Failed to save Read aloud", { kind: "error" });
			}
		});
		$("#wizard-tts-install")?.addEventListener("click", () => runTtsInstall(WIZARD_TTS_ELS));
		$("#wizard-autolearn")?.addEventListener("change", async () => {
			const on = $("#wizard-autolearn").checked;
			try {
				if (!(await authFetch("/api/learning/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: on })
				})).ok) throw new Error("save failed");
				state.learningMasterEnabled = on;
				deps$12.applyLearningMaster();
			} catch {
				$("#wizard-autolearn").checked = !on;
				showToast("Failed to save auto-learn", { kind: "error" });
			}
		});
	}
	const alBox = $("#wizard-autolearn");
	if (alBox) alBox.checked = state.learningMasterEnabled;
	const row = $("#wizard-tts-install-row");
	const badge = $("#wizard-tts-installed");
	const progress = $("#wizard-tts-progress");
	const btn = $("#wizard-tts-install");
	const ttsOn = !!ttsDefault?.checked;
	let st = null;
	try {
		const res = await authFetch("/api/webchat/tts/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st || !ttsOn) {
		if (row) row.hidden = true;
		if (badge) badge.hidden = true;
		if (progress) progress.hidden = !(st && st.running);
		if (st && st.running) pollTtsInstall(WIZARD_TTS_ELS);
		return;
	}
	if (st.installed) {
		if (row) row.hidden = true;
		if (badge) badge.hidden = false;
		if (progress) progress.hidden = !st.running;
		if (btn) btn.textContent = "Install Kokoro…";
		if (st.running) pollTtsInstall(WIZARD_TTS_ELS);
		return;
	}
	if (badge) badge.hidden = true;
	if (row) row.hidden = !st.installerPresent;
	if (st.running) pollTtsInstall(WIZARD_TTS_ELS);
	else if (btn) {
		btn.disabled = false;
		btn.textContent = "Install Kokoro…";
	}
}
var wizardAuthInfo = null;
async function wizardAccessReady() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value || "bearer";
	if (sel === "bearer" || sel === "localhost") return true;
	let info = wizardAuthInfo;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) {
			info = await r.json();
			wizardAuthInfo = info;
		}
	} catch {}
	if (sel === "tailscale") return !!(info && info.tailscale && info.tailscale.healthy);
	if (sel === "sso") return !!(info && info.proxy);
	return true;
}
async function runTailscaleInstall() {
	const btn = $("#wizard-ts-install-btn");
	const log = $("#wizard-ts-install-log");
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Installing…";
	}
	try {
		const res = await authFetch("/api/webchat/tailscale/install", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Install failed to start.";
			showToast(err.error || "Tailscale install failed", {
				kind: "error",
				timeout: 9e3
			});
			if (btn) {
				btn.disabled = false;
				btn.textContent = "Install Tailscale…";
			}
			return;
		}
		pollTailscaleInstall();
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err?.message;
		if (btn) {
			btn.disabled = false;
			btn.textContent = "Install Tailscale…";
		}
	}
}
async function pollTailscaleInstall() {
	if (tailscaleInstallActive.value) return;
	tailscaleInstallActive.value = true;
	const btn = $("#wizard-ts-install-btn");
	const log = $("#wizard-ts-install-log");
	if (log) log.hidden = false;
	if (btn) btn.disabled = true;
	try {
		for (;;) {
			const st = await (await authFetch("/api/webchat/tailscale/install")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-14).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) showToast("Tailscale is up — first tailnet sign-in becomes owner", { kind: "success" });
				else showToast("Tailscale install/sign-in didn’t finish — see the log", {
					kind: "error",
					timeout: 9e3
				});
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("Tailscale install error: " + err?.message, { kind: "error" });
	} finally {
		tailscaleInstallActive.value = false;
		if (btn) {
			btn.disabled = false;
			btn.textContent = "Install Tailscale…";
		}
		renderWizardAccess();
	}
}
async function runCloudflaredBinaryInstall() {
	const btn = $("#wizard-cf-install-btn");
	const log = $("#wizard-cf-install-log");
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	const done = btn ? wizardBusy(btn, "Installing…") : null;
	try {
		const res = await authFetch("/api/webchat/cloudflared/install", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Install failed to start.";
			showToast(err.error || "cloudflared install failed", {
				kind: "error",
				timeout: 9e3
			});
			done?.();
			return;
		}
		done?.();
		pollCloudflared({
			btn: "#wizard-cf-install-btn",
			success: "cloudflared installed — paste your tunnel token"
		});
	} catch (err) {
		if (log) log.textContent = "Install failed: " + err?.message;
		done?.();
	}
}
async function runCloudflaredConnect() {
	const btn = $("#wizard-cf-connect-btn");
	const log = $("#wizard-cf-install-log");
	const tokenEl = $("#wizard-cf-token");
	const token = (tokenEl?.value || "").trim();
	if (!token) {
		showToast("Paste the tunnel token first", { kind: "error" });
		return;
	}
	if (log) {
		log.hidden = false;
		log.textContent = "Starting…";
	}
	const done = btn ? wizardBusy(btn, "Connecting…") : null;
	try {
		const res = await authFetch("/api/webchat/cloudflared/connect", {
			method: "POST",
			headers: {
				"X-Webchat-CSRF": "1",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ token })
		});
		if (!res.ok && res.status !== 202) {
			const err = await res.json().catch(() => ({}));
			if (log) log.textContent = err.error || "Connect failed to start.";
			showToast(err.error || "Cloudflare Tunnel connect failed", {
				kind: "error",
				timeout: 9e3
			});
			done?.();
			return;
		}
		if (tokenEl) tokenEl.value = "";
		done?.();
		pollCloudflared({
			btn: "#wizard-cf-connect-btn",
			success: "Cloudflare Tunnel connected"
		});
	} catch (err) {
		if (log) log.textContent = "Connect failed: " + err?.message;
		done?.();
	}
}
async function pollCloudflared({ btn: btnSel, success }) {
	if (cloudflaredInstallActive.value) return;
	cloudflaredInstallActive.value = true;
	const btn = btnSel ? $(btnSel) : null;
	const log = $("#wizard-cf-install-log");
	if (log) log.hidden = false;
	const done = btn ? wizardBusy(btn, "Working…") : null;
	try {
		for (;;) {
			const st = await (await authFetch("/api/webchat/cloudflared")).json();
			if (log) {
				log.textContent = (st.lines || []).slice(-14).join("\n") || "Starting…";
				log.scrollTop = log.scrollHeight;
			}
			if (!st.running) {
				if (st.exitCode === 0) showToast(success, { kind: "success" });
				else showToast("cloudflared step didn’t finish — see the log", {
					kind: "error",
					timeout: 9e3
				});
				break;
			}
			await new Promise((r) => setTimeout(r, 2e3));
		}
	} catch (err) {
		showToast("cloudflared error: " + err?.message, { kind: "error" });
	} finally {
		cloudflaredInstallActive.value = false;
		done?.();
		renderWizardAccess();
	}
}
var wizardAccessDefaulted = false;
var wizardBearerPendingRestart = false;
var wizardTsPoll = null;
function wizardStopTsPoll() {
	if (wizardTsPoll) {
		clearInterval(wizardTsPoll);
		wizardTsPoll = null;
	}
}
function wizardStartTsPollIfNeeded() {
	const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value;
	const healthy = !!(wizardAuthInfo && wizardAuthInfo.tailscale && wizardAuthInfo.tailscale.healthy);
	if (sel !== "tailscale" || healthy) {
		wizardStopTsPoll();
		return;
	}
	if (wizardTsPoll) return;
	wizardTsPoll = setInterval(async () => {
		try {
			const r = await authFetch("/api/webchat/auth");
			if (!r.ok) return;
			const info = await r.json();
			if (info && info.tailscale && info.tailscale.healthy) {
				wizardStopTsPoll();
				renderWizardAccess();
			}
		} catch {}
	}, 4e3);
}
async function renderWizardAccess() {
	const stateEl = $("#wizard-access-state");
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	wizardAuthInfo = info;
	const tsHealthy = !!(info && info.tailscale && info.tailscale.healthy);
	const tsAuthActive = !!(info && info.tailscale && info.tailscale.enabled && info.tailscale.healthy);
	const proxyOn = !!(info && info.proxy);
	const bearerOn = !!(info && info.bearerActive);
	const localhostOnly = !!(info && info.loopback) && !bearerOn && !tsAuthActive && !proxyOn;
	const chip = (id, text, ok) => {
		const el = $(id);
		if (!el) return;
		el.hidden = !info;
		el.textContent = text;
		el.classList.toggle("ok", ok);
	};
	chip("#wizard-access-localhost-chip", localhostOnly ? "active" : "off", localhostOnly);
	chip("#wizard-access-bearer-chip", bearerOn ? "active" : "off", bearerOn);
	chip("#wizard-access-ts-chip", tsHealthy ? "✓ up" : "not detected", tsHealthy);
	chip("#wizard-access-sso-chip", proxyOn ? "✓ active" : "not configured", proxyOn);
	if (!wizardAccessDefaulted && info) {
		wizardAccessDefaulted = true;
		if (localhostOnly) {
			const r = document.querySelector("input[name=\"wizard-access\"][value=\"localhost\"]");
			if (r) r.checked = true;
		}
	}
	const tsReady = $("#wizard-ts-ready");
	if (tsReady) tsReady.hidden = !tsHealthy;
	const tsHelper = $("#wizard-ts-helper");
	const tsRow = $("#wizard-ts-install-row");
	const tsManual = $("#wizard-ts-manual");
	if (tsHealthy) {
		if (tsHelper) tsHelper.hidden = true;
		if (tsRow) tsRow.hidden = true;
		if (tsManual) tsManual.hidden = true;
	} else {
		let ts = null;
		try {
			const r = await authFetch("/api/webchat/tailscale/install");
			if (r.ok) ts = await r.json();
		} catch {
			ts = null;
		}
		const canInstall = !!(ts && ts.canInstall);
		const tunPresent = !!(ts && ts.tunPresent);
		const isRoot = !!(ts && ts.isRoot);
		if (tsRow) tsRow.hidden = !canInstall;
		if (tsManual) tsManual.hidden = !(!canInstall && tunPresent && !isRoot);
		if (tsHelper) tsHelper.hidden = !(!canInstall && !tunPresent);
		if (canInstall && ts.running) pollTailscaleInstall();
	}
	let cf = null;
	try {
		const r = await authFetch("/api/webchat/cloudflared");
		if (r.ok) cf = await r.json();
	} catch {
		cf = null;
	}
	const cfService = !!(cf && cf.serviceInstalled);
	const cfBinary = !!(cf && cf.installed);
	const cfCanInstall = !!(cf && cf.canInstall);
	chip("#wizard-access-cf-chip", cfService ? "✓ running" : cfBinary ? "installed" : "not set up", cfService);
	const cfReady = $("#wizard-cf-ready");
	if (cfReady) cfReady.hidden = !cfService;
	const cfHelper = $("#wizard-cf-helper");
	if (cfHelper) cfHelper.hidden = cfService || cfCanInstall;
	const cfInstallRow = $("#wizard-cf-install-row");
	if (cfInstallRow) cfInstallRow.hidden = cfService || !cfCanInstall || cfBinary;
	const cfConnect = $("#wizard-cf-connect");
	if (cfConnect) cfConnect.hidden = cfService || !cfCanInstall || !cfBinary;
	if (cfCanInstall && cf.running) pollCloudflared({
		btn: null,
		success: "cloudflared step complete"
	});
	const retireRow = $("#wizard-retire-row");
	if (retireRow) retireRow.hidden = !(info && info.canDisableBearer);
	const bearerUnset = !!(info && !info.bearerConfigured);
	const bearerGenRow = $("#wizard-bearer-gen-row");
	if (bearerGenRow && !wizardBearerPendingRestart) bearerGenRow.hidden = !bearerUnset;
	if (stateEl) {
		if (!info) {
			stateEl.textContent = "Access settings are available to the owner.";
			stateEl.hidden = false;
		} else {
			const methods = [];
			if (tsAuthActive) methods.push("Tailscale identity");
			if (proxyOn) methods.push("reverse-proxy SSO");
			if (bearerOn) methods.push("a bearer token");
			stateEl.textContent = methods.length ? `Secured by ${methods.join(" + ")}.` : "";
			stateEl.hidden = !methods.length;
		}
	}
	syncWizardAccessBodies();
}
async function wizardRetireBearer() {
	const done = wizardBusy($("#wizard-retire-btn"), "Retiring…");
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: false })
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			showToast("Bearer token retired — access is via Tailscale/SSO", { kind: "success" });
			await renderWizardAccess();
		} else wizardSetStatus("#wizard-retire-status", data.error || "Could not retire the token", "err");
	} catch {
		wizardSetStatus("#wizard-retire-status", "Connection failed.", "err");
	} finally {
		done();
	}
}
async function wizardGenerateBearer() {
	const done = wizardBusy($("#wizard-bearer-gen"), "Generating…");
	try {
		const r = await authFetch("/api/webchat/auth/bearer/generate", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok || !data.token) {
			showToast(data.error || "Could not generate a token", {
				kind: "error",
				timeout: 8e3
			});
			return;
		}
		setAuthToken(data.token);
		sessionStorage.setItem("nanoclaw-token", data.token);
		const field = $("#wizard-bearer-token");
		if (field) field.value = data.token;
		if ($("#wizard-bearer-result")) $("#wizard-bearer-result").hidden = false;
		if ($("#wizard-bearer-gen-row")) $("#wizard-bearer-gen-row").hidden = true;
		wizardBearerPendingRestart = true;
	} catch {
		showToast("Connection failed.", { kind: "error" });
	} finally {
		done();
	}
}
async function wizardCopyBearerToken() {
	const field = $("#wizard-bearer-token");
	const value = field?.value || "";
	if (!value) return;
	try {
		await navigator.clipboard.writeText(value);
		showToast("Token copied", { kind: "success" });
	} catch {
		field?.select();
		try {
			document.execCommand("copy");
			showToast("Token copied", { kind: "success" });
		} catch {
			showToast("Copy failed — select the token and copy manually", { kind: "error" });
		}
	}
}
async function wizardCopyText(selector, okMsg) {
	const el = $(selector);
	const text = String((el && "value" in el ? el.value : el?.textContent) || "").trim();
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		showToast(okMsg || "Copied", { kind: "success" });
	} catch {
		el?.select?.();
		showToast("Copy failed — select and copy manually", { kind: "error" });
	}
}
async function wizardTriggerRestart() {
	const overlay = $("#restart-overlay");
	const titleEl = $("#restart-title");
	const statusEl = $("#restart-status");
	const reloadBtn = $("#restart-reload-btn");
	const setStatus = (t) => {
		if (statusEl) statusEl.textContent = t;
	};
	if (overlay) overlay.hidden = false;
	reloadBtn?.addEventListener("click", () => location.reload(), { once: true });
	const readUptime = async () => {
		try {
			const r = await fetch("/health", { cache: "no-store" });
			if (!r.ok) return null;
			const b = await r.json();
			return typeof b.uptime === "number" ? b.uptime : null;
		} catch {
			return null;
		}
	};
	const baseUptime = await readUptime() ?? Infinity;
	try {
		await authFetch("/api/webchat/restart", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
	} catch {}
	const started = Date.now();
	const DEADLINE_MS = 9e4;
	while (Date.now() - started < DEADLINE_MS) {
		await new Promise((r) => setTimeout(r, 1500));
		const up = await readUptime();
		if (up !== null && up < baseUptime) {
			setStatus("Back online — reloading…");
			await new Promise((r) => setTimeout(r, 700));
			location.reload();
			return;
		}
		setStatus("Restarting the server…");
	}
	if (titleEl) titleEl.textContent = "Still restarting…";
	setStatus("This is taking longer than usual. Reload once you can reach the server.");
	if (reloadBtn) reloadBtn.hidden = false;
}
function wireWizard() {
	if (wizardWired) return;
	wizardWired = true;
	$("#wizard-next")?.addEventListener("click", async () => {
		if (!!document.querySelector(`.wizard-step[data-step="${wizardStep}"] input[name="wizard-access"]`) && !await wizardAccessReady()) {
			const sel = document.querySelector("input[name=\"wizard-access\"]:checked")?.value;
			showToast(sel === "tailscale" ? "Connect Tailscale first — sign in over your tailnet (install it above if needed), then continue." : "Configure the reverse proxy first — set WEBCHAT_TRUSTED_PROXY_IPS and restart, then continue.", {
				kind: "info",
				timeout: 8e3
			});
			return;
		}
		if (wizardStep === 2) {
			wizardCreateAndFinish();
			return;
		}
		if (wizardStep === 0 && !wizardEngineConnected()) {
			showToast(`Finish this engine first — ${wizardEngine === "ollama" ? "set a default Ollama model" : wizardEngine === "codex" && !wizardCodexAvailable ? "install then connect Codex" : `connect ${wizardEngine === "codex" ? "Codex" : "Claude"}`} above.`, {
				kind: "info",
				timeout: 6e3
			});
			return;
		}
		showWizardStep(wizardStep + 1);
	});
	$("#wizard-back")?.addEventListener("click", () => showWizardStep(wizardStep - 1));
	$("#wizard-skip")?.addEventListener("click", () => {
		if (wizardStep === 2) finishWizard();
		else showWizardStep(wizardStep + 1);
	});
	$("#wizard-close")?.addEventListener("click", () => finishWizard());
	document.querySelectorAll("input[name=\"wizard-access\"]").forEach((radio) => {
		radio.addEventListener("change", () => syncWizardAccessBodies());
	});
	$("#wizard-https-btn")?.addEventListener("click", () => wizardEnableHttps());
	$("#wizard-ts-install-btn")?.addEventListener("click", () => runTailscaleInstall());
	$("#wizard-cf-install-btn")?.addEventListener("click", () => runCloudflaredBinaryInstall());
	$("#wizard-cf-connect-btn")?.addEventListener("click", () => runCloudflaredConnect());
	$("#wizard-retire-btn")?.addEventListener("click", () => wizardRetireBearer());
	$("#wizard-bearer-gen")?.addEventListener("click", () => wizardGenerateBearer());
	$("#wizard-bearer-copy")?.addEventListener("click", () => wizardCopyBearerToken());
	$("#wizard-ts-manual-copy")?.addEventListener("click", () => wizardCopyText("#wizard-ts-manual-cmd", "Copied"));
	document.querySelectorAll("input[name=\"wizard-engine\"]").forEach((radio) => {
		radio.addEventListener("change", () => {
			wizardEngine = radio.value;
			syncWizardEngineBodies();
			if (wizardEngine === "ollama") wizardCheckLocalOllama();
			else wizardClearOllamaDefault();
		});
	});
	$("#wizard-claude-oauth")?.addEventListener("click", () => deps$12.openOauthMintModal("workspace"));
	$("#wizard-codex-install")?.addEventListener("click", () => runCodexInstall());
	$("#wizard-codex-oauth")?.addEventListener("click", () => deps$12.openOauthMintModal("workspace-codex"));
	$("#wizard-codex-save")?.addEventListener("click", async () => {
		const key = ($("#wizard-codex-key")?.value || "").trim();
		if (!/^sk-/.test(key)) return wizardSetStatus("#wizard-codex-status", "Expected an OpenAI API key (sk-…).", "err");
		const done = wizardBusy($("#wizard-codex-save"), "Saving…");
		try {
			const r = await authFetch("/api/workspace-credential", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					provider: "codex",
					type: "api_key",
					apiKey: key
				})
			});
			const out = await r.json().catch(() => ({}));
			if (!r.ok) return wizardSetStatus("#wizard-codex-status", out.error || "Save failed.", "err");
			$("#wizard-codex-key").value = "";
			await refreshWizardCredState();
		} finally {
			done();
		}
	});
	$("#wizard-claude-save")?.addEventListener("click", async () => {
		const key = ($("#wizard-claude-key")?.value || "").trim();
		if (!/^sk-ant-/.test(key)) return wizardSetStatus("#wizard-claude-status", "Expected an Anthropic API key (sk-ant-…) or setup token (sk-ant-oat…).", "err");
		const isOauth = /^sk-ant-oat/.test(key);
		const done = wizardBusy($("#wizard-claude-save"), "Saving…");
		try {
			const r = await authFetch("/api/workspace-credential", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(isOauth ? {
					type: "oauth_token",
					token: key
				} : {
					type: "api_key",
					apiKey: key
				})
			});
			const out = await r.json().catch(() => ({}));
			if (!r.ok) return wizardSetStatus("#wizard-claude-status", out.error || "Save failed.", "err");
			$("#wizard-claude-key").value = "";
			await refreshWizardCredState();
		} finally {
			done();
		}
	});
	$("#wizard-claude-disconnect")?.addEventListener("click", async () => {
		const r = await authFetch("/api/workspace-credential", { method: "DELETE" });
		if (!r.ok) {
			showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		await refreshWizardCredState();
	});
	$("#wizard-codex-disconnect")?.addEventListener("click", async () => {
		const r = await authFetch("/api/workspace-credential?provider=codex", { method: "DELETE" });
		if (!r.ok) {
			showToast("Failed to disconnect: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		await refreshWizardCredState();
	});
	$("#wizard-ollama-probe")?.addEventListener("click", () => void wizardProbeOllama());
	$("#wizard-ollama-list")?.addEventListener("change", (e) => {
		const t = e.target;
		if (t && t.name === "wizard-ollama-model" && t.value) {
			wizardOllamaSelected.value = t.value;
			wizardSelectOllamaModel(t.value);
		}
	});
	$("#wizard-ollama-change")?.addEventListener("click", () => {
		$("#wizard-ollama-connected").hidden = true;
		$("#wizard-ollama-setup").hidden = false;
	});
	$("#wizard-ollama-install")?.addEventListener("click", async () => {
		const done = wizardBusy($("#wizard-ollama-install"), "Installing…");
		const log = $("#wizard-ollama-install-log");
		log.hidden = false;
		log.textContent = "Starting…";
		try {
			const r = await authFetch("/api/ollama/install", { method: "POST" });
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				if (err.error !== "already-running") {
					log.textContent = err.error || "Install failed to start.";
					return;
				}
				log.textContent = "Resuming the install already in progress…";
			}
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 2e3));
				const st = await (await authFetch("/api/ollama/local")).json();
				log.textContent = (st.lines || []).join("\n") || "Working…";
				log.scrollTop = log.scrollHeight;
				if (!st.running) {
					if (st.exitCode === 0 && st.reachable) {
						$("#wizard-ollama-install-row").hidden = true;
						$("#wizard-ollama-url").value = "http://localhost:11434";
						wizardSetStatus("#wizard-ollama-status", "Ollama installed and running — download a model below.", "ok");
						$("#wizard-ollama-dl-row").hidden = false;
						wizardLoadRecommendation();
					} else wizardSetStatus("#wizard-ollama-status", "Install failed — see the log above.", "err");
					return;
				}
			}
		} finally {
			done();
		}
	});
	$("#wizard-ollama-dl")?.addEventListener("click", async () => {
		const model = ($("#wizard-ollama-dl-model")?.value || "").trim() || "qwen3:1.7b";
		const host = ($("#wizard-ollama-url")?.value || "").trim() || "http://localhost:11434";
		const r = await authFetch("/api/ollama/pull", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				host,
				model
			})
		});
		if (!r.ok) return wizardSetStatus("#wizard-ollama-dl-status", (await r.json().catch(() => ({}))).error || "Pull failed to start.", "err");
		await wizardFollowPull(host, model);
	});
}
async function wizardCreateAndFinish() {
	const roomName = ($("#wizard-room-name")?.value || "").trim() || "General";
	const agentName = ($("#wizard-agent-name")?.value || "").trim() || "Assistant";
	if (wizardEngine !== "ollama") await wizardClearOllamaDefault();
	const mktEnabled = $("#wizard-marketplace")?.checked !== false;
	try {
		await authFetch("/api/webchat/features", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ marketplaceEnabled: mktEnabled })
		});
		state.marketplaceEnabled = mktEnabled;
		applyMarketplaceNav();
	} catch {}
	try {
		await authFetch("/api/webchat/tailscale-owner", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ armed: document.querySelector("input[name=\"wizard-access\"]:checked")?.value === "tailscale" })
		});
	} catch {}
	const done = wizardBusy($("#wizard-next"), "Creating…");
	try {
		const agentRef = {
			kind: "new",
			name: agentName
		};
		if (wizardEngine === "codex") agentRef.provider = "codex";
		const r = await authFetch("/api/rooms", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: roomName,
				agents: [agentRef]
			})
		});
		const out = await r.json().catch(() => ({}));
		if (!r.ok) {
			if (r.status === 409) {
				wizardSetStatus("#wizard-room-status", "Already set up — finishing…", "ok");
				await finishWizard();
				if (wizardBearerPendingRestart) await wizardTriggerRestart();
				return;
			}
			return wizardSetStatus("#wizard-room-status", out.error || "Create failed.", "err");
		}
		wizardSetStatus("#wizard-room-status", "Created. Finishing…", "ok");
		await finishWizard();
		if (wizardBearerPendingRestart) await wizardTriggerRestart();
		if (typeof deps$12.fetchAgents === "function") deps$12.fetchAgents().catch(() => {});
	} finally {
		done();
	}
}
async function maybeAutoOpenWizard() {
	try {
		const r = await authFetch("/api/webchat/onboarding");
		if (!r.ok) return;
		const s = await r.json();
		if (s.canEdit && !s.complete) openWizard();
	} catch {}
}
//#endregion
//#region src/features/ConfirmInput.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$31 = ["placeholder"];
var _hoisted_2$27 = ["hidden"];
//#endregion
//#region src/features/ConfirmInput.vue
var ConfirmInput_default = /* @__PURE__ */ defineComponent({
	__name: "ConfirmInput",
	setup(__props) {
		/**
		* The text field showConfirmModal borrows as its body — sixty-fourth island.
		*
		* Per-instance, like the skill editor and the confirm modal itself: one app per
		* call, mounted into the detached wrapper that is then handed to
		* showConfirmModal as `body`. The modal's element-body contract is unchanged;
		* only what fills that element is Vue now.
		*
		* State comes through provide(), NOT props. Root props are read once at
		* createApp and never update, and two of these can be open at once in principle
		* — a module ref would make the second overwrite the first. The injected object
		* is created per call, so instances cannot collide.
		*
		* The input is UNCONTROLLED: no v-model, no :value. The caller reads
		* input.value at confirm time, exactly as before. v-model would attach an input
		* listener the original only attached when a validator was supplied, and
		* :value would emit a value="" attribute that the imperative .value assignment
		* never produced (type=text is IDL "value" mode — it does not reflect; a radio
		* would, see #244). The element is captured through a function ref so the
		* caller still has the handle it reads.
		*
		* The @input handler is conditional for the same reason: without a validator
		* the original bound nothing at all — hence v-on with an empty object rather
		* than a handler that checks and does nothing, which would still bind.
		*
		* One accepted markup difference, in the NO-VALIDATOR case only: v-if leaves
		* its anchor comment behind, so the wrapper holds <input><!----> where the
		* imperative version held <input>. With a validator both render the error div
		* and there is no anchor, which is why only one of the four probed states
		* differs.
		*
		* The alternatives are all worse than an invisible comment node: v-show would
		* add a real element with a style attribute in the case that had none, always
		* rendering it adds an element outright, and splitting into two components to
		* dodge the anchor duplicates the markup this is meant to unify. Same call as
		* data-v-app on every mount host.
		*/
		const s = inject("confirmInput");
		function capture(el) {
			if (!el) return;
			s.el = el;
			el.value = s.initial;
		}
		function onInput() {
			s.error = "";
			s.invalid = false;
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [createElementVNode("input", mergeProps({
				type: "text",
				class: ["confirm-input", unref(s).invalid ? "invalid" : void 0],
				placeholder: unref(s).placeholder,
				autocomplete: "off",
				ref: capture
			}, toHandlers(unref(s).validate ? { input: onInput } : {}, true)), null, 16, _hoisted_1$31), unref(s).validate ? (openBlock(), createElementBlock("div", {
				key: 0,
				class: "confirm-input-error",
				hidden: !unref(s).error
			}, toDisplayString(unref(s).error), 9, _hoisted_2$27)) : createCommentVNode("", true)], 64);
		};
	}
});
//#endregion
//#region src/features/ConfirmToggle.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$30 = { class: "setting-toggle" };
var _hoisted_2$26 = {
	key: 0,
	class: "import-note"
};
//#endregion
//#region src/features/ConfirmToggle.vue
var ConfirmToggle_default = /* @__PURE__ */ defineComponent({
	__name: "ConfirmToggle",
	setup(__props) {
		/**
		* The checkbox showConfirmModal borrows as its body — sixty-fifth island.
		*
		* Same per-instance shape as ConfirmInput, and state arrives the same way, for
		* the same reason.
		*
		* The checkbox is UNCONTROLLED and its state is read at confirm time from the
		* captured element. `checked` does not reflect to an attribute (measured in
		* #244), so :checked would emit one the imperative `cb.checked` read never
		* produced — and there is nothing here that re-renders, so binding buys
		* nothing anyway.
		*
		* The note is optional and comes AFTER the label, matching the append order.
		*/
		const s = inject("confirmToggle");
		function capture(el) {
			if (el) s.el = el;
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [createElementVNode("label", _hoisted_1$30, [createElementVNode("span", null, toDisplayString(unref(s).toggleLabel), 1), createElementVNode("input", {
				type: "checkbox",
				ref: capture
			}, null, 512)]), unref(s).note ? (openBlock(), createElementBlock("div", _hoisted_2$26, toDisplayString(unref(s).note), 1)) : createCommentVNode("", true)], 64);
		};
	}
});
//#endregion
//#region src/features/ConfirmModal.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$29 = { class: "modal-header" };
var _hoisted_2$25 = {
	key: 0,
	class: "modal-body"
};
var _hoisted_3$23 = { class: "confirm-actions" };
var _hoisted_4$18 = ["onClick"];
//#endregion
//#region src/features/ConfirmModal.vue
var ConfirmModal_default = /* @__PURE__ */ defineComponent({
	__name: "ConfirmModal",
	props: {
		title: {},
		body: {},
		confirmLabel: {},
		cancelLabel: {},
		destructive: { type: Boolean },
		extraActions: {},
		onPick: { type: Function },
		onConfirm: { type: Function }
	},
	setup(__props) {
		/**
		* The confirm dialog — thirty-sixth island, and the most-used modal in the app.
		*
		* Per-instance: the overlay is created by showConfirmModal and the app mounts
		* into it, so the structure stays overlay > modal.
		*
		* `body` may be a STRING or a live HTMLElement, and that contract is load-
		* bearing: showInputModal passes an <input> and reads input.value after the
		* promise resolves; confirmWithToggle passes a checkbox and reads cb.checked.
		* An element body is therefore APPENDED, not rendered — the caller keeps the
		* reference and Vue must not clone or re-create it.
		*
		* There is deliberately NO focus trap here. The skill editor has one because it
		* is a long-lived editing surface; this dialog never had one, and adding it
		* would be a behaviour change smuggled into a conversion.
		*
		* Focus goes to Cancel for destructive actions so an accidental Enter does not
		* delete.
		*/
		const props = __props;
		const message = ref(null);
		const cancelEl = ref(null);
		const confirmEl = ref(null);
		const isEl = computed(() => props.body instanceof HTMLElement);
		const hasBody = computed(() => !!props.body);
		const modalClass = computed(() => "modal confirm-modal" + (props.body ? "" : " confirm-modal--titleonly"));
		function onKey(e) {
			if (e.key === "Escape") props.onPick(false);
			else if (e.key === "Enter") props.onConfirm();
		}
		onMounted(() => {
			if (isEl.value && message.value) message.value.appendChild(props.body);
			document.addEventListener("keydown", onKey);
			(props.destructive ? cancelEl.value : confirmEl.value)?.focus();
		});
		onUnmounted(() => document.removeEventListener("keydown", onKey));
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("div", { class: normalizeClass(modalClass.value) }, [
				createElementVNode("div", _hoisted_1$29, [createElementVNode("span", null, toDisplayString(__props.title || "Confirm"), 1)]),
				hasBody.value ? (openBlock(), createElementBlock("div", _hoisted_2$25, [createElementVNode("div", {
					ref_key: "message",
					ref: message,
					class: "confirm-message"
				}, toDisplayString(isEl.value ? "" : __props.body), 513)])) : createCommentVNode("", true),
				createElementVNode("div", _hoisted_3$23, [
					createElementVNode("button", {
						ref_key: "cancelEl",
						ref: cancelEl,
						type: "button",
						class: "btn-cancel",
						onClick: _cache[0] || (_cache[0] = ($event) => props.onPick(false))
					}, toDisplayString(__props.cancelLabel), 513),
					(openBlock(true), createElementBlock(Fragment, null, renderList(__props.extraActions, (a) => {
						return openBlock(), createElementBlock("button", {
							key: a.label,
							type: "button",
							class: normalizeClass(a.className || "btn btn-secondary"),
							onClick: ($event) => props.onPick(a.value)
						}, toDisplayString(a.label), 11, _hoisted_4$18);
					}), 128)),
					createElementVNode("button", {
						ref_key: "confirmEl",
						ref: confirmEl,
						type: "button",
						class: normalizeClass(__props.destructive ? "btn btn-danger" : "btn btn-primary"),
						onClick: _cache[1] || (_cache[1] = ($event) => props.onConfirm())
					}, toDisplayString(__props.confirmLabel), 3)
				])
			], 2);
		};
	}
});
//#endregion
//#region src/features/mention-popover-state.ts
/** Candidate agents/people for the @-token being typed. */
var mentionMatches = ref([]);
/** Which candidate is highlighted — driven by arrow keys in the composer. */
var mentionSelectedIndex = ref(0);
//#endregion
//#region src/features/MentionPopover.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$28 = ["onMousedown", "onTouchstart"];
var _hoisted_2$24 = { class: "mention-popover-slug" };
var _hoisted_3$22 = {
	key: 0,
	class: "mention-popover-name"
};
var _hoisted_4$17 = {
	key: 1,
	class: "mention-popover-person"
};
var _hoisted_5$15 = {
	key: 2,
	class: "mention-popover-prime"
};
var PERSON = "person";
var DEFAULT_AGENT = "default";
//#endregion
//#region src/features/MentionPopover.vue
var MentionPopover_default = /* @__PURE__ */ defineComponent({
	__name: "MentionPopover",
	props: { onPick: { type: Function } },
	setup(__props) {
		/**
		* The @-mention autocomplete popover — thirty-seventh island.
		*
		* Mounted into the popover element ensureMentionPopover() creates, which is
		* appended next to the composer once and reused.
		*
		* mousedown and touchstart, NOT click. The composer's blur dismisses the
		* popover, and blur fires before click — so a click handler would never run.
		* touchstart is there for iOS, where the synthesized mouse events can land
		* after the blur-dismiss timer. preventDefault keeps the input focused.
		*
		* Placement is pure CSS (absolute above the composer) — nothing to compute.
		*/
		const props = __props;
		const nameLabel = (a) => ` — ${a.name}`;
		function pick(e, i) {
			e.preventDefault();
			props.onPick(i);
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(mentionMatches), (agent, i) => {
				return openBlock(), createElementBlock("div", {
					key: agent.folder ?? i,
					class: normalizeClass(i === unref(mentionSelectedIndex) ? "mention-popover-item active" : "mention-popover-item"),
					onMousedown: ($event) => pick($event, i),
					onTouchstart: withModifiers(($event) => pick($event, i), ["prevent"])
				}, [
					createElementVNode("span", _hoisted_2$24, "@" + toDisplayString(agent.folder), 1),
					agent.name && agent.name !== agent.folder ? (openBlock(), createElementBlock("span", _hoisted_3$22, toDisplayString(nameLabel(agent)), 1)) : createCommentVNode("", true),
					agent.isUser ? (openBlock(), createElementBlock("span", _hoisted_4$17, toDisplayString(PERSON))) : agent.is_prime ? (openBlock(), createElementBlock("span", _hoisted_5$15, toDisplayString(DEFAULT_AGENT))) : createCommentVNode("", true)
				], 42, _hoisted_1$28);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/codex-code-state.ts
/** The device code to enter at the sign-in page. Empty when there is none. */
var codexUserCode = ref("");
/** true when the flow is Codex at all — otherwise the line renders nothing. */
var codexActive = ref(false);
//#endregion
//#region src/features/CodexPairingCode.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$27 = {
	class: "icon",
	"aria-hidden": "true"
};
var _hoisted_2$23 = ["href"];
var PREFIX$1 = "Pairing code: ";
var NO_CODE = "Open the link, then approve the sign-in.";
var COPY_TITLE = "Copy";
var COPY_LABEL = "Copy pairing code";
//#endregion
//#region src/features/CodexPairingCode.vue
var CodexPairingCode_default = /* @__PURE__ */ defineComponent({
	__name: "CodexPairingCode",
	props: { onCopy: { type: Function } },
	setup(__props) {
		/**
		* The Codex device pairing code — forty-seventh island.
		*
		* Mounted into <p id="user-creds-oauth-codex-code">. Its hidden flag stays
		* imperative: the line is shown only for Codex flows, which is a decision the
		* mint modal makes about the whole step.
		*
		* The copy button exists because the operator has to TYPE this code at the
		* ChatGPT sign-in page — copy beats retyping a device code. On success the
		* icon swaps to a check for 1500ms; the swap is state here rather than
		* setAttribute on a <use> href, but the same 1500ms and the same two icons.
		*
		* Only the rest of openOauthMintModal is left imperative, and deliberately: it
		* APPLIES STATE to static markup (hidden flags, textContent, href) rather than
		* building DOM. Converting that would mean claiming a whole modal to set six
		* properties.
		*/
		const props = __props;
		const copied = ref(false);
		let timer = null;
		async function copy() {
			if (!await props.onCopy(codexUserCode.value)) return;
			copied.value = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => copied.value = false, 1500);
		}
		onUnmounted(() => {
			if (timer) clearTimeout(timer);
		});
		return (_ctx, _cache) => {
			return unref(codexActive) && unref(codexUserCode) ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [
				createTextVNode(toDisplayString(PREFIX$1)),
				createElementVNode("code", null, toDisplayString(unref(codexUserCode)), 1),
				createElementVNode("button", {
					type: "button",
					class: normalizeClass(copied.value ? "codex-code-copy copied" : "codex-code-copy"),
					title: COPY_TITLE,
					"aria-label": COPY_LABEL,
					onClick: copy
				}, [(openBlock(), createElementBlock("svg", _hoisted_1$27, [createElementVNode("use", { href: copied.value ? "#i-check" : "#i-copy" }, null, 8, _hoisted_2$23)]))], 2)
			], 64)) : unref(codexActive) ? (openBlock(), createElementBlock(Fragment, { key: 1 }, [createTextVNode(toDisplayString(NO_CODE))], 64)) : createCommentVNode("", true);
		};
	}
});
//#endregion
//#region src/features/modals.ts
var deps$11 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideModalsDeps(provided) {
	Object.assign(deps$11, provided);
}
function openHandlePopover() {
	const pop = $("#handle-popover");
	const input = $("#handle-input");
	const status = $("#handle-status");
	if (!pop) return;
	if (input) input.value = state.myHandle || "";
	if (status) {
		status.hidden = true;
		status.textContent = "";
		status.classList.remove("ok", "err");
	}
	deps$11.updateHandleCreds();
	pop.hidden = false;
	$("#handle-chip")?.setAttribute("aria-expanded", "true");
	if (input) input.focus();
}
function closeHandlePopover() {
	const pop = $("#handle-popover");
	if (!pop || pop.hidden) return;
	pop.hidden = true;
	$("#handle-chip")?.setAttribute("aria-expanded", "false");
}
var lightboxImages = [];
var lightboxIndex = 0;
var prevBodyOverflow = "";
var lightboxCloseTimer = null;
function applyLightboxTransform() {
	const img = $("#lightbox-img");
	img.style.transform = `translate(${lightboxXf.x}px, ${lightboxXf.y}px) scale(${lightboxXf.scale})`;
}
function resetLightboxTransform() {
	lightboxXf.scale = 1;
	lightboxXf.x = 0;
	lightboxXf.y = 0;
	applyLightboxTransform();
}
function setLightboxImage(idx) {
	if (idx < 0 || idx >= lightboxImages.length) return;
	lightboxIndex = idx;
	const { url, alt } = lightboxImages[idx];
	const img = $("#lightbox-img");
	const spinner = $("#lightbox-spinner");
	resetLightboxTransform();
	spinner.hidden = false;
	img.style.visibility = "hidden";
	img.onload = img.onerror = () => {
		spinner.hidden = true;
		img.style.visibility = "";
	};
	img.src = url;
	img.alt = alt;
	const dl = $("#lightbox-download");
	dl.href = url;
	try {
		const tail = new URL(url, location.href).pathname.split("/").pop();
		if (tail) dl.setAttribute("download", tail);
	} catch {
		dl.setAttribute("download", "");
	}
	$("#lightbox-prev").hidden = idx <= 0;
	$("#lightbox-next").hidden = idx >= lightboxImages.length - 1;
}
function openLightbox(url, alt) {
	if (lightboxCloseTimer) {
		clearTimeout(lightboxCloseTimer);
		lightboxCloseTimer = null;
	}
	lightboxImages = snapshotRoomImages();
	let idx = lightboxImages.findIndex((it) => it.url === url);
	if (idx === -1) {
		lightboxImages = [{
			url,
			alt: alt || ""
		}];
		idx = 0;
	}
	const overlay = $("#lightbox");
	overlay.classList.remove("closing");
	overlay.hidden = false;
	lightboxOpen.value = true;
	prevBodyOverflow = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	setLightboxImage(idx);
	history.pushState({ lightbox: true }, "");
	requestAnimationFrame(() => $("#lightbox-close").focus());
}
function closeLightbox(fromPopstate = false) {
	if (!lightboxOpen.value) return;
	const overlay = $("#lightbox");
	lightboxOpen.value = false;
	overlay.classList.add("closing");
	document.body.style.overflow = prevBodyOverflow;
	lightboxCloseTimer = setTimeout(() => {
		lightboxCloseTimer = null;
		overlay.hidden = true;
		overlay.classList.remove("closing");
		$("#lightbox-img").src = "";
		$("#lightbox-img").style.transform = "";
		$("#lightbox-img").style.visibility = "";
	}, 150);
	if (!fromPopstate && history.state && history.state.lightbox) history.back();
}
function navigateLightbox(delta) {
	const next = lightboxIndex + delta;
	if (next < 0 || next >= lightboxImages.length) return;
	setLightboxImage(next);
}
function blockingOverlayOpen() {
	if (document.querySelector(".modal-overlay:not([hidden])")) return true;
	return [
		"model-picker",
		"lightbox",
		"members-overlay",
		"handle-popover",
		"overflow-menu",
		"search-results",
		"learn-menu"
	].some((id) => {
		const el = document.getElementById(id);
		return el && !el.hidden;
	});
}
async function openOauthMintModal(target) {
	userCredsOauthTarget.value = target;
	const modal = $("#user-creds-oauth-modal");
	if (!modal) return;
	const isWorkspace = target.startsWith("workspace");
	const isCodex = target === "workspace-codex" || !isWorkspace && userCredsProvider.value === "codex";
	const title = $("#user-creds-oauth-title");
	if (title) title.textContent = isWorkspace ? `Connect ${isCodex ? "ChatGPT" : "Claude"} (workspace default)` : `Connect to ${userCredsWords(userCredsProvider.value).name}`;
	$("#user-creds-oauth-step2").hidden = true;
	$("#user-creds-oauth-submit").hidden = true;
	$("#user-creds-oauth-spinner").hidden = false;
	const code = $("#user-creds-oauth-code");
	if (code) code.value = "";
	const codexCode = $("#user-creds-oauth-codex-code");
	userCredsOauthReturnFocus.value = document.activeElement;
	modal.hidden = false;
	$("#user-creds-oauth-close")?.focus();
	userCredsOauthStatus("Preparing sign-in…", "");
	try {
		const r = await authFetch(isWorkspace ? isCodex ? "/api/workspace-credential/codex/start" : "/api/workspace-credential/oauth/start" : isCodex ? "/api/user-credentials/codex/start" : "/api/user-credentials/oauth/start", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(isWorkspace ? {} : { roomId: state.currentRoom })
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || r.statusText);
		userCredsOauthSessionId.value = data.sessionId;
		const link = $("#user-creds-oauth-link");
		if (link) {
			link.href = data.url;
			link.textContent = isWorkspace ? `Open ${isCodex ? "ChatGPT" : "Claude"} sign-in ↗` : `Open ${userCredsWords(userCredsProvider.value).name} sign-in ↗`;
		}
		if (code) code.hidden = isCodex;
		const codeLabel = $("#user-creds-oauth-code-label");
		if (codeLabel) codeLabel.hidden = isCodex;
		if (codexCode) {
			codexCode.hidden = !isCodex;
			codexActive.value = isCodex;
			codexUserCode.value = isCodex ? data.userCode || "" : "";
			mountCodexCode();
		}
		const submit = $("#user-creds-oauth-submit");
		if (submit) submit.textContent = isCodex ? "I’ve approved — connect" : "Connect";
		$("#user-creds-oauth-spinner").hidden = true;
		$("#user-creds-oauth-step2").hidden = false;
		$("#user-creds-oauth-submit").hidden = false;
		userCredsOauthStatus(isCodex ? "Open the link, enter the code, and approve — then click connect." : "", "");
		$("#user-creds-oauth-link").focus();
	} catch (err) {
		$("#user-creds-oauth-spinner").hidden = true;
		userCredsOauthStatus(err?.message || "Could not start sign-in.", "error");
	}
}
function showConfirmModal({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, extraActions = [], beforeConfirm = null }) {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "modal-overlay confirm-overlay";
		document.body.appendChild(overlay);
		let settled = false;
		let app = null;
		const close = (result) => {
			if (settled) return;
			settled = true;
			app?.unmount();
			app = null;
			overlay.remove();
			resolve(result);
		};
		const confirm = () => {
			if (beforeConfirm && beforeConfirm() === false) return;
			close(true);
		};
		app = createApp(ConfirmModal_default, {
			title,
			body,
			confirmLabel,
			cancelLabel,
			destructive: !!destructive,
			extraActions,
			onPick: close,
			onConfirm: confirm
		});
		app.mount(overlay);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close(false);
		});
	});
}
async function showInputModal({ title, placeholder = "", value = "", confirmLabel = "Create", validate = null }) {
	const wrap = document.createElement("div");
	const s = reactive({
		placeholder,
		initial: value,
		validate,
		error: "",
		invalid: false,
		el: null
	});
	const app = createApp(ConfirmInput_default);
	app.provide("confirmInput", s);
	app.mount(wrap);
	let beforeConfirm = null;
	if (validate) beforeConfirm = () => {
		const msg = validate((s.el?.value ?? "").trim());
		if (!msg) return true;
		s.error = msg;
		s.invalid = true;
		s.el?.focus();
		return false;
	};
	const done = showConfirmModal({
		title,
		body: wrap,
		confirmLabel,
		beforeConfirm
	});
	s.el?.focus();
	const out = await done ? (s.el?.value ?? "").trim() || null : null;
	app.unmount();
	return out;
}
var mentionPopover = null;
function ensureMentionPopover() {
	if (mentionPopover) return mentionPopover;
	const el = document.createElement("div");
	el.id = "mention-popover";
	el.className = "mention-popover";
	el.hidden = true;
	$("#message-form").appendChild(el);
	mentionPopover = el;
	return el;
}
function dismissMentionPopover() {
	setMentionStart(-1);
	setMentionMatches([]);
	if (mentionPopover) mentionPopover.hidden = true;
}
var codexCodeApp = null;
function mountCodexCode() {
	if (codexCodeApp) return;
	const host = $("#user-creds-oauth-codex-code");
	if (!host) return;
	codexCodeApp = createApp(CodexPairingCode_default, { onCopy: (code) => deps$11.copyTextToClipboard(code) });
	codexCodeApp.mount(host);
}
var mentionApp = null;
function renderMentionPopover(input) {
	const el = ensureMentionPopover();
	if (getMentionMatches().length === 0) {
		el.hidden = true;
		return;
	}
	mentionMatches.value = getMentionMatches();
	mentionSelectedIndex.value = getMentionSelectedIndex();
	if (!mentionApp) {
		mentionApp = createApp(MentionPopover_default, { onPick: (i) => {
			setMentionSelectedIndex(i);
			deps$11.acceptMention(input);
		} });
		mentionApp.mount(el);
	}
	el.hidden = false;
}
async function inspectAndConfirmImport(importBody, displayName, community) {
	let insp = null;
	try {
		const res = await authFetch("/api/skills/inspect", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...importBody,
				official: !community
			})
		});
		if (res.ok) insp = await res.json();
	} catch {}
	if (!insp) return showConfirmModal({
		title: `Import ${displayName}?`,
		body: community ? "This is a community skill — its instructions and scripts will run in your agents. Review it first." : void 0,
		confirmLabel: "Import",
		destructive: !!community
	});
	const el = document.createElement("div");
	const line = (text, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = text;
		el.appendChild(d);
	};
	const kb = Math.max(1, Math.round(insp.totalBytes / 1024));
	line(`${insp.files} file${insp.files === 1 ? "" : "s"} · ${kb} KB · SKILL.md ≈ ${insp.skillMdTokens.toLocaleString()} tokens of agent context`);
	line(insp.scripts.length ? `Scripts: ${insp.scripts.slice(0, 5).join(", ")}${insp.scripts.length > 5 ? ` +${insp.scripts.length - 5} more` : ""}` : "No scripts — instructions only");
	if (insp.externalHosts.length) line(`Links out to: ${insp.externalHosts.slice(0, 6).join(", ")}`);
	for (const w of insp.warnings) line(`⚠ ${w}`, "import-warning");
	if (community) line("Community skill — unvetted. Its instructions and any scripts run in your agents.", "import-note");
	return showConfirmModal({
		title: `Import ${displayName}?`,
		body: el,
		confirmLabel: "Import",
		destructive: !!community || insp.warnings.length > 0
	});
}
async function confirmWithToggle({ title, toggleLabel, note, confirmLabel }) {
	const el = document.createElement("div");
	const s = reactive({
		toggleLabel,
		note,
		el: null
	});
	const app = createApp(ConfirmToggle_default);
	app.provide("confirmToggle", s);
	app.mount(el);
	const ok = await showConfirmModal({
		title,
		body: el,
		confirmLabel
	});
	const checked = !!s.el?.checked;
	app.unmount();
	return {
		ok,
		checked
	};
}
function wireModalsPanel() {
	$("#handle-chip")?.addEventListener("click", (e) => {
		e.stopPropagation();
		const pop = $("#handle-popover");
		if (pop && pop.hidden) openHandlePopover();
		else closeHandlePopover();
	});
	$("#handle-popover-close")?.addEventListener("click", closeHandlePopover);
	document.addEventListener("click", (e) => {
		const pop = $("#handle-popover");
		if (!pop || pop.hidden) return;
		if (pop.contains(e.target) || e.target === $("#handle-chip")) return;
		closeHandlePopover();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeHandlePopover();
	});
	applySettings();
	document.addEventListener("click", (e) => {
		const btn = e.target?.closest(".feature-info-btn");
		if (!btn) return;
		const controls = btn.getAttribute("aria-controls");
		const info = controls ? document.getElementById(controls) : null;
		if (!info) return;
		const open = info.hidden;
		info.hidden = !open;
		btn.setAttribute("aria-expanded", String(open));
	});
	$("#lightbox-close")?.addEventListener("click", () => closeLightbox());
	$("#lightbox-prev")?.addEventListener("click", (e) => {
		e.stopPropagation();
		navigateLightbox(-1);
	});
	$("#lightbox-next")?.addEventListener("click", (e) => {
		e.stopPropagation();
		navigateLightbox(1);
	});
	$("#lightbox-download")?.addEventListener("click", (e) => e.stopPropagation());
	$("#lightbox")?.addEventListener("click", (e) => {
		if (e.target === $("#lightbox")) closeLightbox();
	});
	document.addEventListener("keydown", (e) => {
		if (!lightboxOpen.value) return;
		if (e.key === "Escape") closeLightbox();
		else if (e.key === "ArrowLeft") navigateLightbox(-1);
		else if (e.key === "ArrowRight") navigateLightbox(1);
	});
}
var lightboxXf = {
	scale: 1,
	x: 0,
	y: 0
};
var lightboxGesture = {
	startScale: 1,
	startDist: 0,
	startX: 0,
	startY: 0,
	startTouchX: 0,
	startTouchY: 0,
	mode: null
};
function getTouchDist(touches) {
	const dx = touches[0].clientX - touches[1].clientX;
	const dy = touches[0].clientY - touches[1].clientY;
	return Math.hypot(dx, dy);
}
var lightboxImg = $("#lightbox-img");
/** Pinch-zoom and pan gestures on the lightbox image. */
function wireLightbox() {
	if (!lightboxImg) return;
	lightboxImg.addEventListener("touchstart", (e) => {
		if (e.touches.length === 2) {
			e.preventDefault();
			lightboxGesture.mode = "pinch";
			lightboxGesture.startScale = lightboxXf.scale;
			lightboxGesture.startDist = getTouchDist(e.touches);
			lightboxGesture.startX = lightboxXf.x;
			lightboxGesture.startY = lightboxXf.y;
			lightboxImg.classList.add("dragging");
		} else if (e.touches.length === 1 && lightboxXf.scale > 1) {
			e.preventDefault();
			lightboxGesture.mode = "pan";
			lightboxGesture.startTouchX = e.touches[0].clientX;
			lightboxGesture.startTouchY = e.touches[0].clientY;
			lightboxGesture.startX = lightboxXf.x;
			lightboxGesture.startY = lightboxXf.y;
			lightboxImg.classList.add("dragging");
		}
	}, { passive: false });
	lightboxImg.addEventListener("touchmove", (e) => {
		if (lightboxGesture.mode === "pinch" && e.touches.length === 2) {
			e.preventDefault();
			const ratio = getTouchDist(e.touches) / lightboxGesture.startDist;
			lightboxXf.scale = Math.max(.5, Math.min(4, lightboxGesture.startScale * ratio));
			applyLightboxTransform();
		} else if (lightboxGesture.mode === "pan" && e.touches.length === 1) {
			e.preventDefault();
			lightboxXf.x = lightboxGesture.startX + (e.touches[0].clientX - lightboxGesture.startTouchX);
			lightboxXf.y = lightboxGesture.startY + (e.touches[0].clientY - lightboxGesture.startTouchY);
			applyLightboxTransform();
		}
	}, { passive: false });
	lightboxImg.addEventListener("touchend", () => {
		lightboxGesture.mode = null;
		lightboxImg.classList.remove("dragging");
		if (lightboxXf.scale < 1.05) resetLightboxTransform();
	});
}
/** The OAuth mint modal: code submission, spinner and step transitions. */
function wireUserCredsOauth() {
	$("#user-creds-oauth-submit")?.addEventListener("click", async () => {
		const isWorkspace = (userCredsOauthTarget.value ?? "").startsWith("workspace");
		const isCodex = (userCredsOauthTarget.value ?? "") === "workspace-codex" || !isWorkspace && userCredsProvider.value === "codex";
		const code = ($("#user-creds-oauth-code")?.value || "").trim();
		if (!userCredsOauthSessionId.value) return;
		if (!isCodex && !code) return;
		const btn = $("#user-creds-oauth-submit");
		const step2 = $("#user-creds-oauth-step2");
		const spinner = $("#user-creds-oauth-spinner");
		const modal = $("#user-creds-oauth-modal");
		if (!btn || !step2 || !spinner || !modal) return;
		btn.disabled = true;
		step2.hidden = true;
		spinner.hidden = false;
		const { subWord } = userCredsWords(userCredsProvider.value);
		userCredsOauthStatus("Connecting…", "");
		try {
			const finishUrl = isWorkspace ? isCodex ? "/api/workspace-credential/codex/finish" : "/api/workspace-credential/oauth/code" : isCodex ? "/api/user-credentials/codex/finish" : "/api/user-credentials/oauth/code";
			const body = isWorkspace ? isCodex ? { sessionId: userCredsOauthSessionId.value } : {
				sessionId: userCredsOauthSessionId.value,
				code
			} : isCodex ? {
				roomId: state.currentRoom,
				sessionId: userCredsOauthSessionId.value
			} : {
				roomId: state.currentRoom,
				sessionId: userCredsOauthSessionId.value,
				code
			};
			const r = await authFetch(finishUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify(body)
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || r.statusText);
			userCredsOauthSessionId.value = null;
			if (isWorkspace) {
				showToast(`Workspace default ${isCodex ? "ChatGPT" : "Claude"} subscription connected.`, { kind: "success" });
				modal.hidden = true;
				refreshWizardCredState();
			} else {
				showToast(`Connected your ${subWord}.`, { kind: "success" });
				modal.hidden = true;
				await updateUserCredsBanner(state.currentRoom);
			}
		} catch (err) {
			spinner.hidden = true;
			step2.hidden = false;
			userCredsOauthStatus(err.message || "Could not connect.", "error");
		} finally {
			btn.disabled = false;
		}
	});
}
/**
* The OAuth modal's status line. It writes #user-creds-oauth-status, which is
* this modal's own markup — it sat in members.ts and was handed back through a
* bridge entry, which is the shape of a function filed under the wrong owner.
*/
function userCredsOauthStatus(msg, kind) {
	const el = $("#user-creds-oauth-status");
	if (!el) return;
	if (!msg) {
		el.hidden = true;
		return;
	}
	el.hidden = false;
	el.textContent = msg;
	el.className = "user-creds-oauth-status" + (kind ? " " + kind : "");
}
//#endregion
//#region src/features/select-toggle.ts
var deps$10 = {};
function provideSelectToggleDeps(provided) {
	Object.assign(deps$10, provided);
}
/**
* The registered selectable matching this server row, if there is one.
*
* Endpoint comparison is normalised because the same router has been registered
* under several host forms over time.
*/
function findSelectable(kind, endpoint, modelId) {
	const norm = (e) => (e || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
	return allModels.value.find((r) => {
		if (r.model_id !== modelId) return false;
		if (kind === "ollama") return r.kind === "ollama" && norm(r.endpoint) === norm(endpoint);
		return r.kind === "openai-compatible" && /:4000(\/v1)?$/.test(norm(r.endpoint));
	});
}
/** Everything the control renders, decided once — the seam a component needs. */
function selectToggleProps(kind, endpoint, modelId) {
	const existing = findSelectable(kind, endpoint, modelId);
	return {
		existing,
		on: !!existing,
		className: "btn btn-ghost select-toggle" + (existing ? " on" : ""),
		label: existing ? "−" : "+",
		title: existing ? "Remove from selectable models" : "Add to selectable models"
	};
}
/**
* What the +/− click does. Shared by the imperative builder and SelectToggle.vue
* so the two cannot drift — the component owns none of this.
*
* `setBusy` is how the caller disables its own control: the button element in
* the imperative case, a ref in the component's. It is called with false only
* on failure, matching the original, because on success fetchModels() re-renders
* the row away.
*/
async function toggleSelectable(kind, endpoint, modelId, displayName, setBusy) {
	const existing = findSelectable(kind, endpoint, modelId);
	setBusy(true);
	try {
		if (existing) {
			const r = await authFetch("/api/models/" + encodeURIComponent(existing.id), { method: "DELETE" });
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				const who = (existing.agents || []).map((a) => a.name).join(", ");
				throw new Error(who ? "in use by " + who + " — unassign first" : body.error || r.status);
			}
			showToast("Removed from selectable models");
		} else {
			const r = await authFetch("/api/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: displayName,
					kind,
					endpoint,
					model_id: modelId
				})
			});
			if (!r.ok) throw new Error((await r.json()).error || r.status);
			showToast("Added to selectable models", { kind: "success" });
		}
		await deps$10.fetchModels();
		deps$10.refreshRouterRoster();
	} catch (err) {
		showToast(String(err.message || err), { kind: "error" });
		setBusy(false);
	}
}
//#endregion
//#region src/features/model-usage-state.ts
/** Agent names this model is assigned to. Empty renders the not-assigned note. */
var modelAssignees = ref([]);
//#endregion
//#region src/features/ModelUsage.vue?vue&type=script&setup=true&lang.ts
var PREFIX = "Assigned to: ";
var NONE = "Not assigned to any agent yet.";
//#endregion
//#region src/features/ModelUsage.vue
var ModelUsage_default = /* @__PURE__ */ defineComponent({
	__name: "ModelUsage",
	setup(__props) {
		/**
		* The "assigned to" line in the model detail pane — fifty-first island.
		*
		* Mounted into <div id="model-detail-usage">, exclusively owned by this module.
		*
		* The rest of openModelDetail stays imperative and that is deliberate: it
		* APPLIES STATE to static markup — title, badge, explainer, four input values,
		* a hidden flag — rather than building DOM. This block is the only part that
		* builds anything. Third time this shape has come up (renderTtsSetupSettings,
		* openOauthMintModal, here), so the rule is worth stating: convert what BUILDS,
		* leave what SETS.
		*
		* The prefix is a bare text node followed by chips with no separator, exactly
		* as appendChild(createTextNode(…)) produced — so it is bound rather than
		* written as template text, which would carry the surrounding newlines.
		*/
		return (_ctx, _cache) => {
			return unref(modelAssignees).length ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createTextVNode(toDisplayString(PREFIX)), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(modelAssignees), (n, i) => {
				return openBlock(), createElementBlock("span", {
					key: i,
					class: "model-assignee-chip"
				}, toDisplayString(n), 1);
			}), 128))], 64)) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [createTextVNode(toDisplayString(NONE))], 64));
		};
	}
});
//#endregion
//#region src/features/route-list-state.ts
/** Routes in draft order — the order IS the match order. */
var routeRows = ref([]);
/** The route name that runs when nothing else matches. */
var routeDefaultName = ref("");
/** Index of the open route, or -1. Only highlights while the detail is open. */
var routeSelectedIdx = ref(-1);
/** Capabilities the router offers to route but that no route covers yet. */
var routeSuggestions = ref([]);
/**
* Capabilities whose Create is in flight.
*
* The imperative version disabled the button element directly and re-enabled it
* on failure; a save that succeeds re-fetches and the row disappears on its own.
*/
var routeSuggestBusy = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/RouteList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$26 = {
	key: 0,
	class: "ollama-muted"
};
var _hoisted_2$22 = ["onClick", "onKeydown"];
var _hoisted_3$21 = { class: "route-row-top" };
var _hoisted_4$16 = {
	key: 0,
	class: "model-kind-badge kind-anthropic"
};
var _hoisted_5$14 = { class: "model-row-name" };
var _hoisted_6$12 = {
	key: 1,
	class: "model-kind-badge model-default-badge"
};
var _hoisted_7$8 = {
	key: 2,
	class: "model-row-uses"
};
var _hoisted_8$6 = {
	key: 3,
	class: "model-row-host"
};
var EMPTY$6 = "No routes yet — add one, or a suggestion will offer to.";
var NO_DESC = "No description — click to add the rule";
var ESCALATE = "escalate";
var DEFAULT_CHIP = "default";
var PINNED = "pinned";
//#endregion
//#region src/features/RouteList.vue
var RouteList_default = /* @__PURE__ */ defineComponent({
	__name: "RouteList",
	props: { onActivate: { type: Function } },
	setup(__props) {
		/**
		* The auto-routing rule list — fifty-second island.
		*
		* Mounted into <ul id="route-list">, exclusively owned by this module.
		*
		* Same list grammar as Agents/Models/MCP: rows open a detail aside, chips carry
		* state (default / pinned / escalates), and the bound model rides as dim meta.
		*
		* makeRowActivatable() is replicated inline — role/tabindex, click, Enter and
		* Space — rather than called. That helper attaches listeners imperatively to a
		* node it is handed, which is the thing an island exists to stop doing. McpList
		* made the same call for the same reason.
		*
		* The active row keys off routeSelectedIdx alone, which legacy sets to -1 when
		* the detail pane is closed. A separate `detailOpen` prop would be read once at
		* createApp and never update — root props are not reactive.
		*
		* An escalating route shows no bound model: escalation hands the turn to
		* Claude, so there is nothing local to name.
		*/
		const props = __props;
		function onKey(e, i) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onActivate(i);
			}
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [unref(routeRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$26, toDisplayString(EMPTY$6))) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(routeRows), (r, i) => {
				return openBlock(), createElementBlock("li", {
					key: r.name,
					class: normalizeClass(i === unref(routeSelectedIdx) ? "route-row active" : "route-row"),
					role: "button",
					tabindex: "0",
					onClick: ($event) => props.onActivate(i),
					onKeydown: ($event) => onKey($event, i)
				}, [createElementVNode("div", _hoisted_3$21, [
					r.escalate ? (openBlock(), createElementBlock("span", _hoisted_4$16, toDisplayString(ESCALATE))) : createCommentVNode("", true),
					createElementVNode("span", _hoisted_5$14, toDisplayString(r.name), 1),
					unref(routeDefaultName) === r.name ? (openBlock(), createElementBlock("span", _hoisted_6$12, toDisplayString(DEFAULT_CHIP))) : createCommentVNode("", true),
					r.pinned ? (openBlock(), createElementBlock("span", _hoisted_7$8, toDisplayString(PINNED))) : createCommentVNode("", true),
					!r.escalate ? (openBlock(), createElementBlock("span", _hoisted_8$6, toDisplayString(r.model || ""), 1)) : createCommentVNode("", true)
				]), createElementVNode("div", { class: normalizeClass(r.description ? "route-row-desc" : "route-row-desc empty") }, toDisplayString(r.description || NO_DESC), 3)], 42, _hoisted_2$22);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/RouteSuggestions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$25 = { class: "route-suggestion-text" };
var _hoisted_2$21 = ["disabled", "onClick"];
//#endregion
//#region src/features/RouteSuggestions.vue
var RouteSuggestions_default = /* @__PURE__ */ defineComponent({
	__name: "RouteSuggestions",
	props: { onCreate: { type: Function } },
	setup(__props) {
		/**
		* Capability routes the router could add but hasn't — sixty-first island.
		*
		* Mounted into <div id="route-suggestions">, exclusively owned by this module.
		* The host's own `hidden` flag stays imperative: Vue manages an element's
		* CHILDREN, not the element, and hiding an empty box is the renderer's job in
		* exactly the way #agent-keys-count was.
		*
		* The sentence was built with innerHTML and esc() — two <strong> spans inside
		* running text. It is written here on ONE line: the imperative version produced
		* no whitespace around the tags, and template text carries its newlines.
		*
		* Creating a route disables its button while the save is in flight and
		* re-enables it if the save fails. That is an async pass reaching back into an
		* already-rendered row, so it is state (`routeSuggestBusy`) rather than a DOM
		* mutation — the same reason skillUpdating exists.
		*
		* The busy state produces NO markup difference, unlike the `checked` cases in
		* #196, #217, #233 and #236. `disabled` is a reflected IDL attribute: the
		* imperative `btn.disabled = true` writes `disabled=""` into the DOM just as
		* :disabled does. `checked` does not reflect — that is why those slices had a
		* difference to accept and this one does not. The busy-state diff is run
		* anyway, and confirms it.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(routeSuggestions), (s) => {
				return openBlock(), createElementBlock("div", {
					key: s.capability,
					class: "route-suggestion"
				}, [createElementVNode("span", _hoisted_1$25, [
					createElementVNode("strong", null, toDisplayString(s.model), 1),
					_cache[0] || (_cache[0] = createTextVNode(" can do ", -1)),
					createElementVNode("strong", null, toDisplayString(s.capability), 1),
					_cache[1] || (_cache[1] = createTextVNode(" — no route covers it yet.", -1))
				]), createElementVNode("button", {
					class: "btn btn-secondary",
					type: "button",
					disabled: unref(routeSuggestBusy).has(s.capability) || void 0,
					onClick: ($event) => props.onCreate(s)
				}, "Create " + toDisplayString(s.capability) + " route", 9, _hoisted_2$21)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/routing-decisions-state.ts
/** The already-filtered, already-sliced decision rows for the open profile. */
var decisions = ref([]);
/**
* Which of the three terminal states the list is in.
*
* The imperative version expressed these as three different innerHTML writes
* into the same element, which is why a failure mid-render could leave rows from
* the previous profile sitting above an error line. One field cannot do that.
*/
var decisionsPhase = ref("rows");
/** Router profile name, shown in the empty message. */
var decisionsRouter = ref("auto");
//#endregion
//#region src/features/RoutingDecisions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$24 = {
	key: 0,
	class: "ollama-muted"
};
var _hoisted_2$20 = {
	key: 1,
	class: "ollama-muted"
};
var _hoisted_3$20 = ["title"];
var ERROR_TEXT = "Log unavailable";
//#endregion
//#region src/features/RoutingDecisions.vue
var RoutingDecisions_default = /* @__PURE__ */ defineComponent({
	__name: "RoutingDecisions",
	setup(__props) {
		/**
		* The router's recent decisions — twenty-third island.
		*
		* Mounted into <div id="routing-decisions-list">, exclusively owned by this
		* module.
		*
		* Rows are <div>, not <li> — the host is a div and always was. Worth saying
		* because every other list island in this phase is a <ul>.
		*
		* The row text is ONE binding, not five interpolations with separators between
		* them. The imperative version set textContent, which is a single text node;
		* `{{ when }} · {{ mode }} · …` would produce nine. They serialise the same, but
		* the DOM diff compares what is there, so the shapes are kept the same too.
		*
		* esc() is gone from the empty message: it was needed because the string went
		* into innerHTML, and a text binding escapes by construction.
		*/
		const emptyText = computed(() => `No decisions yet for ${decisionsRouter.value}`);
		/** Translate the log's internal sentinels to plain language for display. */
		const rows = computed(() => decisions.value.map((d, i) => {
			const when = new Date(d.ts).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit"
			});
			const route = d.route === "__error__" ? "classifier error" : d.route;
			const rawModel = d.final_model || d.bound_model || "";
			const model = rawModel === "__escalate__" ? "escalated to Claude" : rawModel;
			return {
				key: `${i}:${d.ts}`,
				err: d.route === "__error__",
				text: `${when} · ${d.mode || "shadow"} · ${route} → ${model} · ${d.ms} ms`,
				title: d.prompt_head || ""
			};
		}));
		return (_ctx, _cache) => {
			return unref(decisionsPhase) === "error" ? (openBlock(), createElementBlock("div", _hoisted_1$24, toDisplayString(ERROR_TEXT))) : unref(decisionsPhase) === "empty" ? (openBlock(), createElementBlock("div", _hoisted_2$20, toDisplayString(emptyText.value), 1)) : (openBlock(true), createElementBlock(Fragment, { key: 2 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("div", {
					key: r.key,
					class: normalizeClass(r.err ? "routing-decision-row err" : "routing-decision-row"),
					title: r.title
				}, toDisplayString(r.text), 11, _hoisted_3$20);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/agent-skills-state.ts
var agentSkillRows = ref([]);
var agentSkillsEnabled = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/AgentSkillsList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$23 = {
	key: 0,
	class: "agent-mcp-empty"
};
var _hoisted_2$19 = ["onClick", "onKeydown"];
var _hoisted_3$19 = { class: "agent-mcp-name" };
var _hoisted_4$15 = { class: "agent-mcp-meta" };
var _hoisted_5$13 = [
	".checked",
	"data-skill",
	"aria-label"
];
var EMPTY$5 = "No skills available in this install";
//#endregion
//#region src/features/AgentSkillsList.vue
var AgentSkillsList_default = /* @__PURE__ */ defineComponent({
	__name: "AgentSkillsList",
	emits: ["view", "dirty"],
	setup(__props, { emit: __emit }) {
		/**
		* Skills available to the open agent, with per-skill enable toggles.
		*
		* Mounted into <ul id="agent-skills-list">. The fetch, the count badge, the
		* scoped-skills sub-list and the Save button all stay in renderAgentSkills().
		*
		* Known, accepted DOM difference: Vue emits a `checked` ATTRIBUTE on the
		* enabled boxes; the imperative version assigned only the PROPERTY, which does
		* not serialise. Both the .prop modifier and a plain :checked bind produce the
		* attribute, so this is Vue's rendering, not a template mistake.
		*
		* Inert here, and checked rather than assumed: the property is correct on every
		* row (verified in-browser), saveAgentSkills() reads the property, and nothing
		* in this UI resets the form — which is the only path where the attribute's
		* defaultChecked meaning would diverge.
		*
		* The checkbox is UNCONTROLLED on purpose: the binding sets initial state and
		* nothing binds it back. saveAgentSkills() reads the boxes out of the DOM, so
		* making them controlled would require re-implementing that read against a ref
		* for no gain — and would silently change what Save sends.
		*/
		const emit = __emit;
		return (_ctx, _cache) => {
			return unref(agentSkillRows).length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$23, toDisplayString(EMPTY$5))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(agentSkillRows), (s) => {
				return openBlock(), createElementBlock("li", {
					key: s.name,
					class: "agent-skill-row"
				}, [createElementVNode("div", {
					class: "agent-mcp-info",
					style: { cursor: "pointer" },
					role: "button",
					tabindex: "0",
					title: "View skill details",
					onClick: ($event) => emit("view", s.name),
					onKeydown: [withKeys(withModifiers(($event) => emit("view", s.name), ["prevent"]), ["enter"]), withKeys(withModifiers(($event) => emit("view", s.name), ["prevent"]), ["space"])]
				}, [createElementVNode("span", _hoisted_3$19, toDisplayString(s.name ?? ""), 1), createElementVNode("span", _hoisted_4$15, toDisplayString(s.description || ""), 1)], 40, _hoisted_2$19), createElementVNode("input", {
					type: "checkbox",
					class: "agent-skill-toggle",
					".checked": unref(agentSkillsEnabled).has(s.name),
					"data-skill": s.name,
					"aria-label": `Enable skill ${s.name}`,
					onChange: _cache[0] || (_cache[0] = ($event) => emit("dirty"))
				}, null, 40, _hoisted_5$13)]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/learn-menu-state.ts
/**
* Whether the two room-scoped toggles are shown at all. They appear only when
* the caller can manage this room's learning AND the workspace master is on.
*/
var learnTogglesVisible = ref(false);
/** Auto-distill busy turns, for this room. */
var learnAutoTrigger = ref(false);
/** Auto-keep drafts, for this room. */
var learnAutoKeep = ref(false);
//#endregion
//#region src/features/LearnMenu.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$22 = ["onClick"];
var _hoisted_2$18 = {
	class: "icon",
	"aria-hidden": "true"
};
var _hoisted_3$18 = ["href"];
var _hoisted_4$14 = { class: "learn-menu-key" };
var _hoisted_5$12 = ["aria-checked"];
var _hoisted_6$11 = ["aria-checked"];
var AUTO_TRIGGER = "Auto-distill busy turns (this room)";
var AUTO_KEEP = "Auto-keep drafts (this room)";
//#endregion
//#region src/features/LearnMenu.vue
var LearnMenu_default = /* @__PURE__ */ defineComponent({
	__name: "LearnMenu",
	props: {
		onSession: { type: Function },
		onLink: { type: Function },
		onFolder: { type: Function },
		onAutoTrigger: { type: Function },
		onAutoKeep: { type: Function }
	},
	setup(__props) {
		/**
		* The 🎓 learn menu — forty-first island.
		*
		* Mounted into <div id="learn-menu">, exclusively owned by this module. The
		* #learn-btn trigger and its aria-expanded stay imperative — outside the mount
		* point.
		*
		* Three fixed actions, then ONE pair of room-scoped toggles. One pair, not one
		* per agent: the room layer overrides the wired agents' defaults, so many
		* agents never means many switches.
		*
		* aria-checked binds the BOOLEAN. Vue renders aria-* false as the string
		* "false" rather than dropping the attribute, which is what the imperative
		* setAttribute(…, String(!!on)) produced — verified in the diff, not assumed.
		*
		* The toggles are menuitemcheckbox rows whose state text doubles as the value —
		* the imperative version read `state.textContent !== 'on'` to decide the next
		* value. That is a ref here, but the optimistic rule is preserved exactly: the
		* row only flips once the write comes back true.
		*/
		const props = __props;
		const ITEMS = [
			{
				icon: "i-sparkles",
				label: "This session",
				key: "session"
			},
			{
				icon: "i-link",
				label: "From a link…",
				key: "link"
			},
			{
				icon: "i-folder",
				label: "From a folder…",
				key: "folder"
			}
		];
		function fire(key) {
			if (key === "session") props.onSession();
			else if (key === "link") props.onLink();
			else props.onFolder();
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [(openBlock(), createElementBlock(Fragment, null, renderList(ITEMS, (it) => {
				return createElementVNode("button", {
					key: it.key,
					type: "button",
					class: "learn-menu-item",
					role: "menuitem",
					onClick: ($event) => fire(it.key)
				}, [(openBlock(), createElementBlock("svg", _hoisted_2$18, [createElementVNode("use", { href: `#${it.icon}` }, null, 8, _hoisted_3$18)])), createElementVNode("span", _hoisted_4$14, toDisplayString(it.label), 1)], 8, _hoisted_1$22);
			}), 64)), unref(learnTogglesVisible) ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("button", {
				type: "button",
				class: "learn-menu-item",
				role: "menuitemcheckbox",
				"aria-checked": unref(learnAutoTrigger),
				onClick: _cache[0] || (_cache[0] = ($event) => props.onAutoTrigger(!unref(learnAutoTrigger)))
			}, [createElementVNode("span", null, toDisplayString(AUTO_TRIGGER)), createElementVNode("span", { class: normalizeClass(unref(learnAutoTrigger) ? "learn-menu-state on" : "learn-menu-state") }, toDisplayString(unref(learnAutoTrigger) ? "on" : "off"), 3)], 8, _hoisted_5$12), createElementVNode("button", {
				type: "button",
				class: "learn-menu-item",
				role: "menuitemcheckbox",
				"aria-checked": unref(learnAutoKeep),
				onClick: _cache[1] || (_cache[1] = ($event) => props.onAutoKeep(!unref(learnAutoKeep)))
			}, [createElementVNode("span", null, toDisplayString(AUTO_KEEP)), createElementVNode("span", { class: normalizeClass(unref(learnAutoKeep) ? "learn-menu-state on" : "learn-menu-state") }, toDisplayString(unref(learnAutoKeep) ? "on" : "off"), 3)], 8, _hoisted_6$11)], 64)) : createCommentVNode("", true)], 64);
		};
	}
});
//#endregion
//#region src/features/LearnTargetPicker.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$21 = [
	"^value",
	"disabled",
	"title"
];
var _hoisted_2$17 = ["hidden"];
var _hoisted_3$17 = ["value"];
//#endregion
//#region src/features/LearnTargetPicker.vue
var LearnTargetPicker_default = /* @__PURE__ */ defineComponent({
	__name: "LearnTargetPicker",
	setup(__props) {
		/**
		* The "learn with which agent?" body — sixty-sixth island.
		*
		* Per-instance and provide()-injected, like the two confirm bodies in #246 and
		* for the same reasons. showConfirmModal's element-body contract is unchanged.
		*
		* The room select is DERIVED from the agent select rather than rebuilt by a
		* change handler. That was the imperative syncRooms(): clear the options,
		* append the new ones, and hide the whole select when the agent serves one room.
		* As a computed it is the same rule stated once.
		*
		* Both selects are UNCONTROLLED — the caller reads .value at confirm time, so
		* no v-model. The agent select does carry one @change, which is exactly the one
		* listener the imperative version bound; it only updates which rooms are
		* derived, and never writes the select's own value back.
		*
		* The initial agent is assigned once in onMounted, not through a binding. The
		* original set agentSel.value AFTER appending the options — a select's value
		* cannot be set before the option exists — and a per-render assignment would
		* fight the user's own selection.
		*
		* Attribute order follows the imperative assignment order, which the DOM diff
		* enforces: class before aria-label on the selects, and value/disabled/title on
		* the options (new Option(text, value) sets value first).
		*
		* Hence :value.attr on the agent options. Vue sets an <option>'s value as a DOM
		* PROPERTY, which reflects to the attribute afterwards and therefore lands it
		* LAST — the diff read `disabled title value` against the original's
		* `value disabled title`. The .attr modifier makes it a plain attribute so it
		* is written in template order. The room options never carry a second
		* attribute, so the order cannot show there.
		*/
		const s = inject("learnTarget");
		const agent = ref(s.initialAgent);
		const rooms = computed(() => s.roomsByAgent.get(agent.value) || []);
		function captureAgent(el) {
			if (el) s.agentEl = el;
		}
		function captureRoom(el) {
			if (el) s.roomEl = el;
		}
		onMounted(() => {
			if (s.agentEl) s.agentEl.value = s.initialAgent;
		});
		function onAgentChange(e) {
			agent.value = e.target.value;
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [createElementVNode("select", {
				class: "confirm-input",
				"aria-label": "Agent",
				ref: captureAgent,
				onChange: onAgentChange
			}, [(openBlock(true), createElementBlock(Fragment, null, renderList(unref(s).agents, (a) => {
				return openBlock(), createElementBlock("option", {
					key: a.id,
					"^value": a.id,
					disabled: (unref(s).roomsByAgent.get(a.id) || []).length === 0 || void 0,
					title: (unref(s).roomsByAgent.get(a.id) || []).length === 0 ? "No room" : void 0
				}, toDisplayString(a.name), 9, _hoisted_1$21);
			}), 128))], 544), createElementVNode("select", {
				class: "confirm-input",
				"aria-label": "Room",
				ref: captureRoom,
				hidden: rooms.value.length <= 1
			}, [(openBlock(true), createElementBlock(Fragment, null, renderList(rooms.value, (r) => {
				return openBlock(), createElementBlock("option", {
					key: r.id,
					value: r.id
				}, toDisplayString(r.name), 9, _hoisted_3$17);
			}), 128))], 8, _hoisted_2$17)], 64);
		};
	}
});
//#endregion
//#region src/features/learn.ts
var deps$9 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideLearnDeps(provided) {
	Object.assign(deps$9, provided);
}
function applyLearningMaster() {
	const learnBtn = document.getElementById("learn-btn");
	if (learnBtn) learnBtn.hidden = !state.learningMasterEnabled;
	if (!state.learningMasterEnabled) hideLearnNudge();
}
async function loadLearningMaster() {
	try {
		const r = await authFetch("/api/learning/config");
		if (r.ok) state.learningMasterEnabled = (await r.json()).enabled !== false;
	} catch {}
	applyLearningMaster();
}
var autoLearnWired = false;
async function renderAutoLearnSetting() {
	const section = document.getElementById("settings-autolearn");
	if (!section) return;
	let cfg = null;
	try {
		const r = await authFetch("/api/learning/config");
		if (r.ok) cfg = await r.json();
	} catch {
		cfg = null;
	}
	if (!cfg || !cfg.canEdit) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	state.learningMasterEnabled = cfg.enabled !== false;
	document.querySelectorAll("#autolearn-mode .setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.value === (state.learningMasterEnabled ? "on" : "off"));
	});
	const clfGroup = document.getElementById("autolearn-classifier-group");
	const clfSelect = document.getElementById("autolearn-classifier-select");
	if (clfGroup) clfGroup.hidden = !state.learningMasterEnabled;
	if (state.learningMasterEnabled && clfSelect && clfSelect.options.length <= 1) try {
		const models = await (await authFetch("/api/models")).json();
		clfSelect.innerHTML = "<option value=\"\">None — busy-turn heuristic</option>";
		for (const m of models) {
			if (m.kind !== "ollama" && m.kind !== "openai-compatible" || !m.endpoint) continue;
			const opt = document.createElement("option");
			opt.value = m.id;
			opt.textContent = `${m.name} (${m.model_id})`;
			clfSelect.appendChild(opt);
		}
	} catch {}
	if (clfSelect) clfSelect.value = cfg.classifierModelId || "";
	if (autoLearnWired) return;
	autoLearnWired = true;
	document.querySelectorAll("#autolearn-mode .setting-option").forEach((b) => {
		b.addEventListener("click", async () => {
			const on = b.dataset.value === "on";
			const r = await authFetch("/api/learning/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: on })
			});
			if (!r.ok) {
				showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				return;
			}
			state.learningMasterEnabled = on;
			document.querySelectorAll("#autolearn-mode .setting-option").forEach((x) => x.classList.toggle("active", x === b));
			applyLearningMaster();
			if (clfGroup) clfGroup.hidden = !on;
			showToast(on ? "Auto-learn on — takes effect as each agent restarts" : "Auto-learn off for the whole workspace — takes effect as each agent restarts");
		});
	});
	clfSelect?.addEventListener("change", async () => {
		const value = clfSelect.value || null;
		const r = await authFetch("/api/learning/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ classifierModelId: value })
		});
		if (!r.ok) {
			showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			renderAutoLearnSetting();
			return;
		}
		showToast(value ? "Classifier set — decides skill-worthy turns (applies as agents restart)" : "Classifier off — back to the busy-turn heuristic", { kind: "success" });
	});
}
async function pickLearnTarget() {
	let agents = [];
	try {
		agents = await apiJson("/api/agents");
	} catch (err) {
		toastError(err, "Could not load agents");
		return null;
	}
	if (!Array.isArray(agents) || agents.length === 0) {
		showToast("No agents you administer", { kind: "error" });
		return null;
	}
	const roomsByAgent = /* @__PURE__ */ new Map();
	await Promise.all(agents.map(async (a) => {
		try {
			const r = await authFetch(`/api/agents/${encodeURIComponent(a.id)}/rooms`);
			roomsByAgent.set(a.id, r.ok ? await r.json() : []);
		} catch {
			roomsByAgent.set(a.id, []);
		}
	}));
	const firstWithRoom = agents.find((a) => (roomsByAgent.get(a.id) || []).length > 0);
	if (!firstWithRoom) {
		showToast("No agent has a room — wire one to a room first", { kind: "error" });
		return null;
	}
	const body = document.createElement("div");
	body.className = "learn-target-picker";
	const s = reactive({
		agents,
		roomsByAgent,
		initialAgent: firstWithRoom.id,
		agentEl: null,
		roomEl: null
	});
	const app = createApp(LearnTargetPicker_default);
	app.provide("learnTarget", s);
	app.mount(body);
	const ok = await showConfirmModal({
		title: "Learn with which agent?",
		body,
		confirmLabel: "Learn"
	});
	const picked = s.agentEl?.value ?? firstWithRoom.id;
	const roomValue = s.roomEl?.value;
	app.unmount();
	if (!ok) return null;
	const rooms = roomsByAgent.get(picked) || [];
	return (rooms.length > 1 ? rooms.find((r) => r.id === roomValue) : rooms[0]) || null;
}
function triggerLearn(command = "/learn") {
	const input = $("#message-input");
	if (!input || input.disabled || !state.currentRoom) return;
	hideLearnNudge();
	input.value = command;
	deps$9.sendCurrentMessage();
}
function learnSourceFirstToken(value) {
	return value.trim().split(/\s+/)[0] || "";
}
function isLearnUrlToken(tok) {
	if (!/^https?:\/\/\S+$/i.test(tok)) return false;
	try {
		new URL(tok);
		return true;
	} catch {
		return false;
	}
}
function isLearnPathToken(tok) {
	return tok === "~" || tok === "." || tok === ".." || /^(\/|\.\/|\.\.\/|~\/)/.test(tok);
}
async function promptLearnSource({ title, placeholder, check, invalid }) {
	return await showInputModal({
		title,
		placeholder,
		confirmLabel: "Learn",
		validate: (val) => val && check(learnSourceFirstToken(val)) ? null : invalid
	});
}
function showLearnNudge() {
	if (!state.learningMasterEnabled) return;
	const n = $("#learn-nudge");
	if (n) n.hidden = false;
}
function hideLearnNudge() {
	const n = $("#learn-nudge");
	if (n) n.hidden = true;
}
var learnMenuApp = null;
function mountLearnMenu() {
	if (learnMenuApp) return;
	const host = $("#learn-menu");
	if (!host) return;
	learnMenuApp = createApp(LearnMenu_default, {
		onSession: () => {
			closeLearnMenu();
			triggerLearn();
		},
		onLink: async () => {
			closeLearnMenu();
			const v = await promptLearnSource({
				title: "Learn from a link",
				placeholder: "https://…",
				check: isLearnUrlToken,
				invalid: "Start with a full link (http:// or https://)"
			});
			if (v) triggerLearn("/learn " + v);
		},
		onFolder: async () => {
			closeLearnMenu();
			const v = await promptLearnSource({
				title: "Learn from a folder",
				placeholder: "/workspace/…",
				check: isLearnPathToken,
				invalid: "Start with a path (/, ./ or ~/)"
			});
			if (v) triggerLearn("/learn " + v);
		},
		onAutoTrigger: async (on) => {
			if (await putRoomLearning({ autoTrigger: on })) learnAutoTrigger.value = on;
		},
		onAutoKeep: async (on) => {
			if (await putRoomLearning({ autoKeep: on })) learnAutoKeep.value = on;
		}
	});
	learnMenuApp.mount(host);
}
async function toggleLearnMenu() {
	const menu = $("#learn-menu");
	if (!menu) return;
	if (!menu.hidden) {
		closeLearnMenu();
		return;
	}
	if (!state.currentRoom) return;
	let cfg = null;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(state.currentRoom)}/learning`);
		if (res.ok) cfg = await res.json();
	} catch {}
	learnTogglesVisible.value = !!(cfg && cfg.canManage && state.learningMasterEnabled);
	learnAutoTrigger.value = !!cfg?.autoTrigger;
	learnAutoKeep.value = !!cfg?.autoKeep;
	mountLearnMenu();
	menu.hidden = false;
	$("#learn-btn")?.setAttribute("aria-expanded", "true");
}
function closeLearnMenu() {
	const menu = $("#learn-menu");
	if (menu) menu.hidden = true;
	$("#learn-btn")?.setAttribute("aria-expanded", "false");
}
function wireLearnPanel() {
	(() => {
		const more = document.getElementById("composer-more");
		const tools = document.getElementById("composer-tools");
		if (!more || !tools) return;
		const close = () => {
			tools.classList.remove("open");
			more.setAttribute("aria-expanded", "false");
		};
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			const open = !tools.classList.contains("open");
			tools.classList.toggle("open", open);
			more.setAttribute("aria-expanded", String(open));
		});
		tools.addEventListener("click", (e) => {
			if (e.target?.closest("button")) close();
		});
		document.addEventListener("click", (e) => {
			if (tools.classList.contains("open") && !tools.contains(e.target) && e.target?.closest("#composer-more") === null) close();
		});
	})();
	document.addEventListener("click", (e) => {
		const menu = $("#learn-menu");
		if (menu && !menu.hidden && !menu.contains(e.target) && e.target?.closest("#learn-btn") === null) closeLearnMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !($("#learn-menu")?.hidden ?? true)) closeLearnMenu();
	});
	$("#learn-nudge-go")?.addEventListener("click", () => triggerLearn());
	$("#learn-nudge-dismiss")?.addEventListener("click", hideLearnNudge);
}
//#endregion
//#region src/features/skills-panel-state.ts
/** /api/skills/duplicates rows — a name plus the agents that each learned it. */
var skillDuplicates = ref([]);
/** One agent's own scoped skills, as the agent detail pane receives them. */
var agentScopedSkills = ref([]);
/**
* Rows whose promote button is mid-request.
*
* The imperative version disabled the clicked BUTTON directly and re-enabled it
* on failure. There is no clicked element to hold onto once the row is a vnode,
* and disabling by identity is what keeps a double-click from promoting twice —
* so the pending set is state. Keyed by skill name, which is what the endpoint
* takes.
*/
var promotingSkills = ref(/* @__PURE__ */ new Set());
/**
* Skill collections shown in Settings, already shaped.
*
* `kind` distinguishes the two row types the one template renders: 'source' is
* an editable GitHub collection, 'builtin' a marketplace entry. `raw` carries
* the record the callbacks need — it is never rendered.
*/
var skillSources = ref([]);
var skillSections = ref([]);
/** 'loading' | 'empty' | 'ready' — the registry's three list-level states. */
var skillsPhase = ref("loading");
/** Lower-cased filter box contents. An active filter OWNS section expansion. */
var skillsFilter = ref("");
/** Section keys currently expanded, when no filter is active. */
var skillsOpenSections = ref(/* @__PURE__ */ new Set());
/** Skill name → true when its source repo has newer commits. */
var skillUpdates = ref({});
/** Skill names whose Update request is in flight. */
var skillUpdating = ref(/* @__PURE__ */ new Set());
/** One learned-skill draft awaiting review. */
var skillDrafts = ref([]);
/**
* Draft id → the undo countdown currently replacing its actions.
*
* armUndo held this in the DOM by swapping the actions element's children. As
* state it survives a re-render, which the imperative version could not manage —
* it froze the element's width to stop the row jumping instead.
*/
var draftUndo = ref({});
/** Drafts whose Keep is mid-flight; a re-render must not resurrect a live Keep. */
var draftsReviewing = ref(/* @__PURE__ */ new Set());
/** The marketplace pool's rows for the open trust tier. */
var skillPool = ref([]);
/** 'loading' | 'error' | 'empty' | 'ready' — the pool's four list-level states. */
var skillPoolPhase = ref("loading");
/** The wait/empty copy differs when a search is active, so the query rides along. */
var skillPoolQuery = ref("");
/** Community tier shows a Review link; Anthropic tier does not. */
var skillPoolCommunity = ref(false);
/** Skill suggestions for the agent-create form, derived from its prompt text. */
var skillSuggestions = ref([]);
/** Room-skills rows, already shaped and ordered: proposed, then learned, then archived. */
var roomSkillRows = ref([]);
/** Draft id → its undo countdown, same shape as draftUndo but for this list. */
var roomSkillUndo = ref({});
/** Draft ids whose Keep is mid-flight. */
var roomSkillsReviewing = ref(/* @__PURE__ */ new Set());
/** In-transcript draft cards: id → its undo countdown. */
var cardUndo = ref({});
/** In-transcript draft cards whose Keep is mid-flight. */
var cardReviewing = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/SkillDuplicates.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$20 = { class: "skill-info" };
var _hoisted_2$16 = { class: "skill-head" };
var _hoisted_3$16 = { class: "skill-name" };
var _hoisted_4$13 = { class: "skill-desc" };
var _hoisted_5$11 = ["disabled", "onClick"];
var PROMOTE = "Promote";
//#endregion
//#region src/features/SkillDuplicates.vue
var SkillDuplicates_default = /* @__PURE__ */ defineComponent({
	__name: "SkillDuplicates",
	props: { onPromote: { type: Function } },
	setup(__props) {
		/**
		* Skills several agents learned independently — twenty-first island.
		*
		* Mounted into <ul id="skill-duplicates-list">, exclusively owned by this
		* module. The #skill-duplicates wrapper's hidden flag is outside the mount
		* point and stays imperative.
		*
		* The badge here is NOT an OriginBadge. It looks like one and shares its
		* classes, but it is a fixed hue 48 with a count in the label rather than a
		* provenance link — originBadgeProps would compute a hue from the text and
		* change the colour. Kept as literal markup for that reason.
		*
		* `promote.disabled = true` on the clicked element became a pending SET,
		* because there is no clicked element to hold once the row is a vnode and
		* disabling is what stops a double-click promoting twice.
		*/
		const props = __props;
		const DUP_HUE = { "--badge-hue": "48" };
		const rows = computed(() => skillDuplicates.value.map((d) => ({
			name: d.name,
			badge: `learned · ${d.agents.length} agents`,
			agents: d.agents.join(", ")
		})));
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.name,
					class: "skill-row"
				}, [createElementVNode("div", _hoisted_1$20, [createElementVNode("div", _hoisted_2$16, [createElementVNode("span", _hoisted_3$16, toDisplayString(r.name), 1), createElementVNode("span", {
					class: "skill-badge skill-badge-origin",
					style: DUP_HUE
				}, toDisplayString(r.badge), 1)]), createElementVNode("span", _hoisted_4$13, toDisplayString(r.agents), 1)]), createElementVNode("button", {
					type: "button",
					class: "btn btn-secondary skill-catalog-add",
					disabled: unref(promotingSkills).has(r.name),
					onClick: ($event) => props.onPromote(r.name)
				}, toDisplayString(PROMOTE), 8, _hoisted_5$11)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/AgentScopedSkills.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$19 = {
	key: 0,
	class: "agent-mcp-empty"
};
var _hoisted_2$15 = ["onClick", "onKeydown"];
var _hoisted_3$15 = { class: "skill-head" };
var _hoisted_4$12 = { class: "agent-mcp-name" };
var _hoisted_5$10 = { class: "agent-mcp-meta" };
var _hoisted_6$10 = ["onClick"];
var EMPTY$4 = "None yet — import one below (this agent only).";
var REMOVE$3 = "Remove";
var OPEN_TITLE = "View / edit this skill";
//#endregion
//#region src/features/AgentScopedSkills.vue
var AgentScopedSkills_default = /* @__PURE__ */ defineComponent({
	__name: "AgentScopedSkills",
	props: {
		onOpen: { type: Function },
		onRemove: { type: Function }
	},
	setup(__props) {
		/**
		* An agent's own scoped skills — twenty-second island.
		*
		* Mounted into <ul id="agent-scoped-list">, exclusively owned by this module.
		* #agent-scoped-add and #agent-scoped-url are outside the mount point; skills.ts
		* still wires those.
		*
		* First island to render an OriginBadge for a REAL origin object (the MCP
		* sources one builds its own literal), so this is where the component meets the
		* shape skills.ts actually stores. The badge appears only when origin.label is
		* truthy — origin itself can be present but empty.
		*
		* The info column keeps its inline cursor:pointer. It belongs in style.css, but
		* moving it would be a CSS change riding in a conversion commit.
		*/
		const props = __props;
		const CLICKABLE = { cursor: "pointer" };
		const rows = computed(() => agentScopedSkills.value.map((s) => ({
			name: s.name ?? "",
			desc: s.description || "",
			origin: s.origin && s.origin.label ? s.origin : null
		})));
		function onKey(e, name) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onOpen(name);
			}
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [rows.value.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_1$19, toDisplayString(EMPTY$4))) : createCommentVNode("", true), (openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.name,
					class: "agent-skill-row"
				}, [createElementVNode("div", {
					class: "agent-mcp-info",
					style: CLICKABLE,
					role: "button",
					tabindex: "0",
					title: OPEN_TITLE,
					onClick: ($event) => props.onOpen(r.name),
					onKeydown: ($event) => onKey($event, r.name)
				}, [createElementVNode("div", _hoisted_3$15, [createElementVNode("span", _hoisted_4$12, toDisplayString(r.name), 1), r.origin ? (openBlock(), createBlock(OriginBadge_default, {
					key: 0,
					origin: r.origin
				}, null, 8, ["origin"])) : createCommentVNode("", true)]), createElementVNode("span", _hoisted_5$10, toDisplayString(r.desc), 1)], 40, _hoisted_2$15), createElementVNode("button", {
					type: "button",
					class: "skill-delete",
					onClick: ($event) => props.onRemove(r.name, $event.currentTarget)
				}, toDisplayString(REMOVE$3), 8, _hoisted_6$10)]);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/SkillSources.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$18 = { class: "skill-info" };
var _hoisted_2$14 = { class: "skill-head" };
var _hoisted_3$14 = { class: "skill-desc" };
var _hoisted_4$11 = ["onClick"];
var _hoisted_5$9 = ["onClick"];
var _hoisted_6$9 = ["onClick"];
var EDIT = "Edit";
var REMOVE$2 = "Remove";
var ADD$2 = "Add";
var BUILT_IN = "built-in";
//#endregion
//#region src/features/SkillSources.vue
var SkillSources_default = /* @__PURE__ */ defineComponent({
	__name: "SkillSources",
	props: {
		onEdit: { type: Function },
		onRemove: { type: Function },
		onToggleBuiltin: { type: Function }
	},
	setup(__props) {
		/**
		* The skill collections list in Settings — twenty-seventh island.
		*
		* Mounted into <ul id="skill-sources-list">, exclusively owned by this module.
		* #settings-skill-sources (the section's owner-only hidden flag) is outside the
		* mount point and stays imperative.
		*
		* Two row kinds share one shape and one template: editable GitHub collections
		* (Edit + Remove) and built-in marketplace sources (a built-in badge and a
		* reversible Add/Remove, since there is no URL to re-paste). The imperative
		* version expressed the shared part as a local sourceRow() helper and then
		* appended different buttons to its result; `kind` selects instead.
		*
		* Each row leads with the same coloured OriginBadge as the pool, so a
		* collection's colour is consistent between Settings and the catalog.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(skillSources), (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.key,
					class: normalizeClass(r.disabled ? "skill-source-row source-disabled" : "skill-source-row")
				}, [createElementVNode("div", _hoisted_1$18, [createElementVNode("div", _hoisted_2$14, [createVNode(OriginBadge_default, { origin: r.origin }, null, 8, ["origin"])]), createElementVNode("span", _hoisted_3$14, toDisplayString(r.meta), 1)]), r.kind === "source" ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost",
					onClick: ($event) => props.onEdit(r)
				}, toDisplayString(EDIT), 8, _hoisted_4$11), createElementVNode("button", {
					type: "button",
					class: "skill-delete",
					onClick: ($event) => props.onRemove(r)
				}, toDisplayString(REMOVE$2), 8, _hoisted_5$9)], 64)) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [createElementVNode("span", { class: "skill-badge" }, toDisplayString(BUILT_IN)), createElementVNode("button", {
					type: "button",
					class: normalizeClass(r.disabled ? "btn btn-ghost" : "skill-delete"),
					onClick: ($event) => props.onToggleBuiltin(r)
				}, toDisplayString(r.disabled ? ADD$2 : REMOVE$2), 11, _hoisted_6$9)], 64))], 2);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/SkillsRegistry.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$17 = {
	key: 0,
	class: "skills-empty"
};
var _hoisted_2$13 = {
	key: 1,
	class: "skills-empty"
};
var _hoisted_3$13 = [
	"data-section-head",
	"hidden",
	"aria-expanded",
	"onClick",
	"onKeydown"
];
var _hoisted_4$10 = { class: "skills-section-label" };
var _hoisted_5$8 = {
	key: 0,
	class: "skill-badge skill-badge-scope"
};
var _hoisted_6$8 = { class: "skills-section-count" };
var _hoisted_7$7 = [
	"data-section",
	"data-search",
	"hidden"
];
var _hoisted_8$5 = ["onClick", "onKeydown"];
var _hoisted_9$3 = { class: "skill-head" };
var _hoisted_10$3 = { class: "skill-name" };
var _hoisted_11$2 = { class: "skill-desc" };
var _hoisted_12$2 = ["disabled", "onClick"];
var _hoisted_13$2 = ["onClick"];
var _hoisted_14$2 = ["onClick"];
var _hoisted_15$2 = ["onClick"];
var _hoisted_16$2 = ["hidden"];
var LOADING$2 = "Loading…";
var EMPTY$3 = "No skills yet — import one above.";
var NO_MATCH = "No matching skills";
var REMOVE$1 = "Remove";
var HISTORY = "History";
var UPDATE = "Update";
var UPDATING = "Updating…";
var UPDATE_TITLE = "The source repo has newer commits — re-import from it";
var CHEVRON$1 = "›";
//#endregion
//#region src/features/SkillsRegistry.vue
var SkillsRegistry_default = /* @__PURE__ */ defineComponent({
	__name: "SkillsRegistry",
	props: {
		onOpen: { type: Function },
		onToggleSection: { type: Function },
		onDelete: { type: Function },
		onHistory: { type: Function },
		onUpdate: { type: Function }
	},
	setup(__props) {
		/**
		* The skills registry — twenty-eighth island.
		*
		* Mounted into <ul id="skills-list">, exclusively owned by this module.
		*
		* Five functions wrote into this list: renderSkillsRegistry built it,
		* buildSkillsSectionHead made the section headers, appendSkillRow made the rows,
		* applySkillsSections hid and showed them by filter and expansion, and
		* markSkillUpdates injected an Update button into rows AFTER the fact by
		* querying for data-skill. That last one is why the updates are state here:
		* an async pass that reaches into already-rendered rows is exactly what an
		* island cannot allow.
		*
		* The Update button precedes Remove because markSkillUpdates used
		* `insertBefore(btn, li.querySelector('.skill-delete'))`, not appendChild — the
		* kind of detail that reads as arbitrary until the DOM diff disagrees with you.
		*
		* Visibility is `hidden`, not v-if. applySkillsSections set the hidden PROPERTY
		* on rows that stay in the DOM, and the filter counts matches by reading them —
		* v-if would remove the rows and change what "no matching skills" means.
		*
		* An active filter OWNS expansion: sections ignore their open state while one is
		* typed, and a section with no matches hides its header entirely.
		*/
		const props = __props;
		const view = computed(() => {
			const q = skillsFilter.value;
			return skillSections.value.map((s) => {
				const shown = q ? s.rows.filter((r) => r.search.includes(q)).length : 0;
				const open = q ? shown > 0 : skillsOpenSections.value.has(s.key);
				return {
					...s,
					open,
					headHidden: q ? shown === 0 : false,
					rowHidden: (r) => q ? !r.search.includes(q) : !skillsOpenSections.value.has(s.key)
				};
			});
		});
		const anyMatch = computed(() => !!skillsFilter.value && view.value.some((s) => !s.headHidden));
		return (_ctx, _cache) => {
			return unref(skillsPhase) === "loading" ? (openBlock(), createElementBlock("li", _hoisted_1$17, toDisplayString(LOADING$2))) : unref(skillsPhase) === "empty" ? (openBlock(), createElementBlock("li", _hoisted_2$13, toDisplayString(EMPTY$3))) : (openBlock(), createElementBlock(Fragment, { key: 2 }, [(openBlock(true), createElementBlock(Fragment, null, renderList(view.value, (s) => {
				return openBlock(), createElementBlock(Fragment, { key: s.key }, [createElementVNode("li", {
					class: normalizeClass(s.open ? "skills-section-head open" : "skills-section-head"),
					"data-section-head": s.key,
					hidden: s.headHidden,
					role: "button",
					tabindex: "0",
					"aria-expanded": s.open ? "true" : "false",
					onClick: ($event) => props.onToggleSection(s.key),
					onKeydown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							props.onToggleSection(s.key);
						}
					}
				}, [
					createElementVNode("span", { class: "skills-section-chevron" }, toDisplayString(CHEVRON$1)),
					createElementVNode("span", _hoisted_4$10, toDisplayString(s.label), 1),
					s.roomName ? (openBlock(), createElementBlock("span", _hoisted_5$8, toDisplayString(s.roomName), 1)) : createCommentVNode("", true),
					createElementVNode("span", _hoisted_6$8, toDisplayString(s.rows.length), 1)
				], 42, _hoisted_3$13), (openBlock(true), createElementBlock(Fragment, null, renderList(s.rows, (r) => {
					return openBlock(), createElementBlock("li", mergeProps({
						key: r.key,
						class: "skill-row"
					}, { ref_for: true }, r.source === "user" ? { "data-skill": r.name } : {}, {
						"data-section": s.key,
						"data-search": r.search,
						hidden: s.rowHidden(r)
					}), [createElementVNode("div", {
						class: "skill-info",
						style: { cursor: "pointer" },
						role: "button",
						tabindex: "0",
						onClick: ($event) => props.onOpen(r),
						onKeydown: (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								props.onOpen(r);
							}
						}
					}, [createElementVNode("div", _hoisted_9$3, [
						createElementVNode("span", _hoisted_10$3, toDisplayString(r.name), 1),
						r.badge.kind === "origin" ? (openBlock(), createBlock(OriginBadge_default, {
							key: 0,
							origin: r.badge.origin
						}, null, 8, ["origin"])) : (openBlock(), createElementBlock("span", {
							key: 1,
							class: normalizeClass(r.badge.kind === "scope" ? "skill-badge skill-badge-scope" : r.badge.kind === "shipped" ? "skill-badge" : "skill-badge skill-badge-user")
						}, toDisplayString(r.badge.text), 3)),
						r.extraOrigin ? (openBlock(), createBlock(OriginBadge_default, {
							key: 2,
							origin: r.extraOrigin
						}, null, 8, ["origin"])) : createCommentVNode("", true)
					]), createElementVNode("span", _hoisted_11$2, toDisplayString(r.desc), 1)], 40, _hoisted_8$5), r.source === "user" ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [unref(skillUpdates)[r.name] ? (openBlock(), createElementBlock("button", {
						key: 0,
						type: "button",
						class: "btn btn-secondary skill-update-btn",
						title: UPDATE_TITLE,
						disabled: unref(skillUpdating).has(r.name) || void 0,
						onClick: ($event) => props.onUpdate(r.name)
					}, toDisplayString(unref(skillUpdating).has(r.name) ? UPDATING : UPDATE), 9, _hoisted_12$2)) : createCommentVNode("", true), createElementVNode("button", {
						type: "button",
						class: "skill-delete",
						onClick: ($event) => props.onDelete(r)
					}, toDisplayString(REMOVE$1), 8, _hoisted_13$2)], 64)) : r.source === "scoped" ? (openBlock(), createElementBlock(Fragment, { key: 1 }, [createElementVNode("button", {
						type: "button",
						class: "btn btn-ghost skill-history-btn",
						onClick: ($event) => props.onHistory(r)
					}, toDisplayString(HISTORY), 8, _hoisted_14$2), createElementVNode("button", {
						type: "button",
						class: "skill-delete",
						onClick: ($event) => props.onDelete(r)
					}, toDisplayString(REMOVE$1), 8, _hoisted_15$2)], 64)) : createCommentVNode("", true)], 16, _hoisted_7$7);
				}), 128))], 64);
			}), 128)), createElementVNode("li", {
				id: "skills-no-match",
				class: "skills-empty",
				hidden: !unref(skillsFilter) || anyMatch.value
			}, toDisplayString(NO_MATCH), 8, _hoisted_16$2)], 64));
		};
	}
});
//#endregion
//#region src/features/SkillDrafts.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$16 = ["data-draft-id"];
var _hoisted_2$12 = ["onClick"];
var _hoisted_3$12 = { class: "skill-head" };
var _hoisted_4$9 = { class: "skill-name" };
var _hoisted_5$7 = { class: "skill-desc" };
var _hoisted_6$7 = ["onClick"];
var _hoisted_7$6 = [
	"title",
	"data-draft-id",
	"disabled",
	"onClick"
];
var _hoisted_8$4 = ["onClick"];
var KEEP$1 = "Keep";
var DISCARD$1 = "Discard";
var REVIEWING$1 = "Reviewing…";
var SOURCE = "from this conversation →";
/**
* The separator is BOUND, not a literal space in the template: the imperative
* version did `desc.append(' ', src)`, an explicit text node, and Vue's compiler
* condenses whitespace between an interpolation and an element.
*/
var SPACE = " ";
//#endregion
//#region src/features/SkillDrafts.vue
var SkillDrafts_default = /* @__PURE__ */ defineComponent({
	__name: "SkillDrafts",
	props: {
		undoSeconds: {},
		onOpen: { type: Function },
		onSource: { type: Function },
		onKeep: { type: Function },
		onDiscard: { type: Function },
		onUndo: { type: Function }
	},
	setup(__props) {
		/**
		* Learned-skill drafts awaiting review — twenty-ninth island.
		*
		* Mounted into <ul id="skill-drafts-list">, exclusively owned by this module.
		* The #skill-drafts wrapper's hidden flag and the nav badge are outside the
		* mount point and stay imperative.
		*
		* The Keep/Discard actions are replaced by an UndoTimer while a countdown runs.
		* armUndo did that by swapping the actions element's children and restoring
		* them; here the row simply renders one or the other, so a re-render mid-
		* countdown is harmless — which is what armUndo's width-freezing was working
		* around.
		*/
		const props = __props;
		const LEARNED_HUE = { "--badge-hue": "48" };
		const rows = computed(() => skillDrafts.value.map((d) => ({
			id: d.id,
			raw: d,
			name: d.kind === "patch" ? `${d.targetSkill || d.skillName} (change)` : d.skillName,
			badge: `learned · ${d.agentName}`,
			desc: d.description || "",
			roomId: d.roomId || null,
			keepTitle: `Wire to ${d.agentName}`
		})));
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("li", {
					key: r.id,
					class: "skill-row",
					"data-draft-id": r.id
				}, [createElementVNode("div", {
					class: "skill-info",
					style: { cursor: "pointer" },
					onClick: ($event) => props.onOpen(r.id)
				}, [createElementVNode("div", _hoisted_3$12, [createElementVNode("span", _hoisted_4$9, toDisplayString(r.name), 1), createElementVNode("span", {
					class: "skill-badge skill-badge-origin",
					style: LEARNED_HUE
				}, toDisplayString(r.badge), 1)]), createElementVNode("span", _hoisted_5$7, [createTextVNode(toDisplayString(r.desc), 1), r.roomId ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createTextVNode(toDisplayString(SPACE)), createElementVNode("a", {
					href: "#",
					class: "skill-draft-source",
					onClick: withModifiers(($event) => props.onSource(r.roomId), ["stop", "prevent"])
				}, toDisplayString(SOURCE), 8, _hoisted_6$7)], 64)) : createCommentVNode("", true)])], 8, _hoisted_2$12), createElementVNode("span", mergeProps({ class: "skill-draft-actions" }, { ref_for: true }, unref(draftUndo)[r.id]?.width ? { style: { width: unref(draftUndo)[r.id].width } } : {}), [unref(draftUndo)[r.id] ? (openBlock(), createBlock(UndoTimer_default, {
					key: 0,
					label: unref(draftUndo)[r.id].label,
					seconds: __props.undoSeconds,
					onCommit: ($event) => unref(draftUndo)[r.id].commit(),
					onUndo: ($event) => props.onUndo(r.id)
				}, null, 8, [
					"label",
					"seconds",
					"onCommit",
					"onUndo"
				])) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [createElementVNode("button", {
					type: "button",
					class: "btn btn-secondary skill-catalog-add",
					title: r.keepTitle,
					"data-draft-id": r.id,
					disabled: unref(draftsReviewing).has(r.id) || void 0,
					onClick: ($event) => props.onKeep(r)
				}, toDisplayString(unref(draftsReviewing).has(r.id) ? REVIEWING$1 : KEEP$1), 9, _hoisted_7$6), createElementVNode("button", {
					type: "button",
					class: "skill-delete",
					onClick: ($event) => props.onDiscard(r)
				}, toDisplayString(DISCARD$1), 8, _hoisted_8$4)], 64))], 16)], 8, _hoisted_1$16);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/SkillPool.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$15 = {
	key: 0,
	class: "skills-empty"
};
var _hoisted_2$11 = {
	key: 1,
	class: "skills-empty"
};
var _hoisted_3$11 = {
	key: 2,
	class: "skills-empty"
};
var _hoisted_4$8 = { class: "skill-info" };
var _hoisted_5$6 = { class: "skill-head" };
var _hoisted_6$6 = { class: "skill-name" };
var _hoisted_7$5 = { class: "skill-desc" };
var _hoisted_8$3 = ["href"];
var _hoisted_9$2 = {
	key: 1,
	class: "skill-badge skill-badge-user"
};
var _hoisted_10$2 = ["onClick"];
var FAILED$1 = "Couldn’t load skills — import by URL below.";
var REVIEW = "Review ↗";
var ADDED = "added";
var ADD$1 = "Add";
//#endregion
//#region src/features/SkillPool.vue
var SkillPool_default = /* @__PURE__ */ defineComponent({
	__name: "SkillPool",
	props: { onAdd: { type: Function } },
	setup(__props) {
		/**
		* The skills marketplace pool — thirtieth island.
		*
		* Mounted into <ul id="skills-catalog-list">, exclusively owned by this module.
		*
		* Four list-level states, which the imperative version wrote as four different
		* innerHTML strings into the same element: the wait row, a fetch failure, an
		* empty result, and rows. They are one phase ref, so a failed request cannot
		* leave the previous tier's rows sitting under an error line.
		*
		* The wait and empty copy both change when a search is active, so the query is
		* state too rather than being re-read from the input at render time.
		*
		* The wait row is written out rather than v-html'd from loadingRow(): that
		* helper returns the <li> ITSELF, so v-html would need a wrapper element and
		* produce a nested li. DESIGN.md §5 wants one wait primitive across the app —
		* this is the same markup, and the DOM diff is what holds it to that.
		*
		* The Review link is community-tier only and points at someone else's site, so
		* it keeps target=_blank with rel="noopener noreferrer" — the same treatment
		* OriginBadge gives an outbound URL.
		*/
		const props = __props;
		const waitLabel = computed(() => skillPoolQuery.value ? "Searching…" : "Loading skills…");
		const emptyLabel = computed(() => skillPoolQuery.value ? "No matches." : "Nothing here yet.");
		return (_ctx, _cache) => {
			return unref(skillPoolPhase) === "loading" ? (openBlock(), createElementBlock("li", _hoisted_1$15, [_cache[0] || (_cache[0] = createElementVNode("span", {
				class: "btn-spinner",
				"aria-hidden": "true"
			}, null, -1)), createTextVNode(toDisplayString(waitLabel.value), 1)])) : unref(skillPoolPhase) === "error" ? (openBlock(), createElementBlock("li", _hoisted_2$11, toDisplayString(FAILED$1))) : unref(skillPoolPhase) === "empty" ? (openBlock(), createElementBlock("li", _hoisted_3$11, toDisplayString(emptyLabel.value), 1)) : (openBlock(true), createElementBlock(Fragment, { key: 3 }, renderList(unref(skillPool), (s) => {
				return openBlock(), createElementBlock("li", {
					key: s.name,
					class: "skill-row"
				}, [
					createElementVNode("div", _hoisted_4$8, [createElementVNode("div", _hoisted_5$6, [createElementVNode("span", _hoisted_6$6, toDisplayString(s.name ?? ""), 1), createVNode(OriginBadge_default, { origin: s.origin }, null, 8, ["origin"])]), createElementVNode("span", _hoisted_7$5, toDisplayString(s.description || ""), 1)]),
					unref(skillPoolCommunity) && s.review ? (openBlock(), createElementBlock("a", {
						key: 0,
						class: "skill-review",
						href: s.review,
						target: "_blank",
						rel: "noopener noreferrer"
					}, toDisplayString(REVIEW), 8, _hoisted_8$3)) : createCommentVNode("", true),
					s.installed ? (openBlock(), createElementBlock("span", _hoisted_9$2, toDisplayString(ADDED))) : (openBlock(), createElementBlock("button", {
						key: 2,
						type: "button",
						class: "btn btn-secondary skill-catalog-add",
						onClick: ($event) => props.onAdd(s)
					}, toDisplayString(ADD$1), 8, _hoisted_10$2))
				]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/SkillSuggestions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$14 = { class: "skill-info" };
var _hoisted_2$10 = { class: "skill-head" };
var _hoisted_3$10 = { class: "skill-name" };
var _hoisted_4$7 = { class: "skill-desc" };
var _hoisted_5$5 = {
	key: 0,
	class: "skill-badge"
};
var _hoisted_6$5 = [
	"data-url",
	"data-name",
	"aria-label"
];
var AVAILABLE = "available";
//#endregion
//#region src/features/SkillSuggestions.vue
var SkillSuggestions_default = /* @__PURE__ */ defineComponent({
	__name: "SkillSuggestions",
	setup(__props) {
		/**
		* Suggested skills on the agent-create form — thirty-first island.
		*
		* Mounted into <ul id="agent-create-skills-list">, exclusively owned by this
		* module. The #agent-create-skills block's hidden flag is outside the mount
		* point and stays imperative — it hides the heading too, not just the list.
		*
		* The checkboxes keep their state in the DOM and carry data-url/data-name,
		* because the create-agent submit reads them with querySelectorAll and pulls
		* both off the dataset. Same contract as the two agent pickers: modelling the
		* selection as a ref would mean changing a reader elsewhere, and the failure
		* mode is silent — an agent created with none of the skills you ticked.
		*/
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(skillSuggestions), (s) => {
				return openBlock(), createElementBlock("li", {
					key: s.name,
					class: "agent-create-skill-row"
				}, [createElementVNode("div", _hoisted_1$14, [createElementVNode("div", _hoisted_2$10, [createElementVNode("span", _hoisted_3$10, toDisplayString(s.name ?? ""), 1)]), createElementVNode("span", _hoisted_4$7, toDisplayString(s.description || ""), 1)]), s.source === "installed" ? (openBlock(), createElementBlock("span", _hoisted_5$5, toDisplayString(AVAILABLE))) : (openBlock(), createElementBlock("input", {
					key: 1,
					type: "checkbox",
					class: "agent-create-skill-check",
					"data-url": s.url,
					"data-name": s.name,
					"aria-label": `Add skill ${s.name} (${s.source})`
				}, null, 8, _hoisted_6$5))]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/RoomSkills.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$13 = {
	key: 0,
	class: "room-skill-row proposed"
};
var _hoisted_2$9 = { class: "room-skill-head" };
var _hoisted_3$9 = { class: "room-skill-name" };
var _hoisted_4$6 = { class: "room-skill-desc" };
var _hoisted_5$4 = ["onClick"];
var _hoisted_6$4 = [
	"title",
	"data-draft-id",
	"disabled",
	"onClick"
];
var _hoisted_7$4 = ["onClick"];
var _hoisted_8$2 = {
	key: 1,
	class: "room-skill-row"
};
var _hoisted_9$1 = { class: "room-skill-head" };
var _hoisted_10$1 = { class: "room-skill-name" };
var _hoisted_11$1 = {
	key: 1,
	class: "room-skill-agent"
};
var _hoisted_12$1 = {
	key: 2,
	class: "room-skill-agent"
};
var _hoisted_13$1 = ["onClick"];
var _hoisted_14$1 = ["title", "onClick"];
var _hoisted_15$1 = {
	key: 2,
	class: "room-skill-row room-skill-archived"
};
var _hoisted_16$1 = { class: "room-skill-head" };
var _hoisted_17$1 = { class: "room-skill-name" };
var _hoisted_18$1 = ["onClick"];
var VIEW = "View";
var KEEP = "Keep";
var REVIEWING = "Reviewing…";
var DISCARD = "Discard";
var REVERT$1 = "Revert";
var REVERT_TITLE = "Back to the previous revision";
var RESTORE = "Restore";
var ARCHIVED_TAG = "archived — unused";
var REMOVE_GLYPH = "✕";
//#endregion
//#region src/features/RoomSkills.vue
var RoomSkills_default = /* @__PURE__ */ defineComponent({
	__name: "RoomSkills",
	props: {
		undoSeconds: {},
		onView: { type: Function },
		onKeep: { type: Function },
		onDiscard: { type: Function },
		onUndo: { type: Function },
		onRevert: { type: Function },
		onRemove: { type: Function },
		onRestore: { type: Function }
	},
	setup(__props) {
		/**
		* A room's skills — thirty-second island.
		*
		* Mounted into <ul id="room-skills-list">, exclusively owned by this module.
		* #room-skills-section (its hidden flag), #room-skills-count and the "Distill a
		* skill" trigger are outside the mount point and stay imperative — the section
		* carries that trigger, which is why it stays visible even when the list is
		* empty.
		*
		* Three row kinds in a fixed order, which is editorial rather than incidental:
		* proposals first, because they are the ones asking for a decision; then what is
		* already wired; then the curator's archive, dimmed and restorable.
		*
		* The proposal row reuses UndoTimer for Keep/Discard, so the pattern matches the
		* drafts island — including measuring the actions element's width BEFORE the
		* swap so the row does not jump.
		*/
		const props = __props;
		const rows = computed(() => roomSkillRows.value);
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock(Fragment, { key: r.key }, [r.kind === "proposed" ? (openBlock(), createElementBlock("li", _hoisted_1$13, [
					createElementVNode("div", _hoisted_2$9, [createElementVNode("span", _hoisted_3$9, toDisplayString(r.name), 1), createVNode(OriginBadge_default, { origin: r.origin }, null, 8, ["origin"])]),
					createElementVNode("div", _hoisted_4$6, toDisplayString(r.desc), 1),
					createElementVNode("div", mergeProps({ class: "room-skill-actions" }, { ref_for: true }, unref(roomSkillUndo)[r.id]?.width ? { style: { width: unref(roomSkillUndo)[r.id].width } } : {}), [unref(roomSkillUndo)[r.id] ? (openBlock(), createBlock(UndoTimer_default, {
						key: 0,
						label: unref(roomSkillUndo)[r.id].label,
						seconds: __props.undoSeconds,
						onCommit: ($event) => unref(roomSkillUndo)[r.id].commit(),
						onUndo: ($event) => props.onUndo(r.id)
					}, null, 8, [
						"label",
						"seconds",
						"onCommit",
						"onUndo"
					])) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [
						createElementVNode("button", {
							type: "button",
							class: "btn btn-ghost",
							onClick: ($event) => props.onView(r.id)
						}, toDisplayString(VIEW), 8, _hoisted_5$4),
						createElementVNode("button", {
							type: "button",
							class: "btn btn-primary",
							title: r.keepTitle,
							"data-draft-id": r.id,
							disabled: unref(roomSkillsReviewing).has(r.id) || void 0,
							onClick: ($event) => props.onKeep(r)
						}, toDisplayString(unref(roomSkillsReviewing).has(r.id) ? REVIEWING : KEEP), 9, _hoisted_6$4),
						createElementVNode("button", {
							type: "button",
							class: "skill-delete",
							onClick: ($event) => props.onDiscard(r)
						}, toDisplayString(DISCARD), 8, _hoisted_7$4)
					], 64))], 16)
				])) : r.kind === "learned" ? (openBlock(), createElementBlock("li", _hoisted_8$2, [createElementVNode("div", _hoisted_9$1, [
					createElementVNode("span", _hoisted_10$1, toDisplayString(r.name), 1),
					r.origin ? (openBlock(), createBlock(OriginBadge_default, {
						key: 0,
						origin: r.origin
					}, null, 8, ["origin"])) : createCommentVNode("", true),
					r.who ? (openBlock(), createElementBlock("span", _hoisted_11$1, toDisplayString(r.who), 1)) : createCommentVNode("", true),
					r.uses ? (openBlock(), createElementBlock("span", _hoisted_12$1, toDisplayString(r.uses), 1)) : createCommentVNode("", true),
					r.hasHistory ? (openBlock(), createElementBlock("button", {
						key: 3,
						type: "button",
						class: "btn btn-ghost",
						title: REVERT_TITLE,
						onClick: ($event) => props.onRevert(r)
					}, toDisplayString(REVERT$1), 8, _hoisted_13$1)) : createCommentVNode("", true)
				]), createElementVNode("button", {
					type: "button",
					class: "skill-delete",
					title: r.removeTitle,
					onClick: ($event) => props.onRemove(r)
				}, toDisplayString(REMOVE_GLYPH), 8, _hoisted_14$1)])) : (openBlock(), createElementBlock("li", _hoisted_15$1, [createElementVNode("div", _hoisted_16$1, [createElementVNode("span", _hoisted_17$1, toDisplayString(r.name), 1), createElementVNode("span", { class: "room-skill-agent" }, toDisplayString(ARCHIVED_TAG))]), createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost",
					onClick: ($event) => props.onRestore(r)
				}, toDisplayString(RESTORE), 8, _hoisted_18$1)]))], 64);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/SkillEditorModal.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$12 = { class: "modal-header" };
var _hoisted_2$8 = {
	key: 0,
	class: "skill-badge skill-badge-user"
};
var _hoisted_3$8 = { class: "modal-body" };
var _hoisted_4$5 = ["readonly"];
var _hoisted_5$3 = { class: "confirm-actions" };
var _hoisted_6$3 = ["onClick"];
var _hoisted_7$3 = ["disabled"];
var SAVING = "Saving…";
var SAVE = "Save";
var TITLE_ID = "skill-edit-modal-title";
//#endregion
//#region src/features/SkillEditorModal.vue
var SkillEditorModal_default = /* @__PURE__ */ defineComponent({
	__name: "SkillEditorModal",
	props: {
		name: {},
		body: {},
		editable: { type: Boolean },
		badgeText: {},
		actions: {},
		onSave: { type: Function },
		onClose: { type: Function }
	},
	setup(__props) {
		/**
		* The SKILL.md viewer/editor modal — thirty-fourth island.
		*
		* Per-instance, like SkillDraftCard: an overlay is created and appended to
		* document.body, and one app is mounted into it. Nothing owns document.body, so
		* there is no container to claim.
		*
		* The FOCUS TRAP is the part that matters and is preserved exactly. Keyboard
		* users must not tab behind the overlay (manual-checks SC 2.1.2). The imperative
		* version built its focusable list as [textarea, ...actionButtons, closeButton,
		* saveButton]; that is also DOM order within the dialog, so this queries the
		* dialog instead of tracking each element — same sequence, one source of truth,
		* and it cannot drift as the footer changes.
		*
		* The body is ASSIGNED on mount, not bound. `value` is not a valid attribute on
		* a textarea, and Vue emits one for both :value and the .prop modifier — markup
		* the original never had, since it assigned the DOM property. The textarea is
		* uncontrolled either way: nothing re-reads `body` after open.
		*
		* Escape closes, clicking the overlay itself (never the modal) closes, and the
		* textarea takes focus on the next task — all as before.
		*/
		const props = __props;
		const dialog = ref(null);
		const ta = ref(null);
		const saving = ref(false);
		const saveLabel = ref(SAVE);
		const closeLabel = computed(() => props.editable ? "Cancel" : "Close");
		function onKey(e) {
			if (e.key === "Escape") {
				e.preventDefault();
				props.onClose();
				return;
			}
			if (e.key === "Tab") {
				const focusables = [...dialog.value?.querySelectorAll("textarea, button") ?? []];
				if (!focusables.length) return;
				const i = focusables.indexOf(document.activeElement);
				if (e.shiftKey && i <= 0) {
					e.preventDefault();
					focusables[focusables.length - 1].focus();
				} else if (!e.shiftKey && (i === -1 || i === focusables.length - 1)) {
					e.preventDefault();
					focusables[0].focus();
				}
			}
		}
		async function save() {
			saving.value = true;
			const prev = saveLabel.value;
			saveLabel.value = SAVING;
			try {
				await props.onSave(ta.value?.value ?? "");
				props.onClose();
			} catch (err) {
				saving.value = false;
				saveLabel.value = prev;
				throw err;
			}
		}
		onMounted(() => {
			if (ta.value) ta.value.value = props.body;
			document.addEventListener("keydown", onKey);
			setTimeout(() => ta.value?.focus(), 0);
		});
		onUnmounted(() => document.removeEventListener("keydown", onKey));
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("div", {
				ref_key: "dialog",
				ref: dialog,
				class: "modal skill-edit-modal",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": TITLE_ID
			}, [
				createElementVNode("div", _hoisted_1$12, [createElementVNode("span", { id: TITLE_ID }, toDisplayString(__props.name), 1), __props.badgeText ? (openBlock(), createElementBlock("span", _hoisted_2$8, toDisplayString(__props.badgeText), 1)) : createCommentVNode("", true)]),
				createElementVNode("div", _hoisted_3$8, [createElementVNode("textarea", {
					ref_key: "ta",
					ref: ta,
					class: "skill-edit-textarea",
					readonly: !__props.editable,
					spellcheck: "false"
				}, null, 8, _hoisted_4$5)]),
				createElementVNode("div", _hoisted_5$3, [
					(openBlock(true), createElementBlock(Fragment, null, renderList(__props.actions, (a) => {
						return openBlock(), createElementBlock("button", {
							key: a.label,
							type: "button",
							class: "btn btn-ghost",
							onClick: ($event) => {
								props.onClose();
								a.onClick();
							}
						}, toDisplayString(a.label), 9, _hoisted_6$3);
					}), 128)),
					createElementVNode("button", {
						type: "button",
						class: "btn-cancel",
						onClick: _cache[0] || (_cache[0] = ($event) => props.onClose())
					}, toDisplayString(closeLabel.value), 1),
					__props.editable ? (openBlock(), createElementBlock("button", {
						key: 0,
						type: "button",
						class: "btn btn-primary",
						disabled: saving.value || void 0,
						onClick: _cache[1] || (_cache[1] = ($event) => save())
					}, toDisplayString(saveLabel.value), 9, _hoisted_7$3)) : createCommentVNode("", true)
				])
			], 512);
		};
	}
});
//#endregion
//#region src/features/skills.ts
var deps$8 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideSkillsDeps(provided) {
	Object.assign(deps$8, provided);
}
/** The in-flight editor draft. Read-only to the outside. */
function getSkillEditorDraft() {
	return skillEditorDraft;
}
function skillDraftRow(msg) {
	refreshDraftBadge();
	let d = {};
	try {
		d = JSON.parse(msg.content) || {};
	} catch {
		d = {};
	}
	const id = d.draftId || msg.id;
	const resolved = d.status === "kept" || d.status === "discarded";
	const title = d.kind === "patch" ? `Proposed change to ${d.targetSkill || d.skillName}` : `Proposed skill: ${d.skillName}`;
	if (reviewingDrafts.has(id)) cardReviewing.value = new Set(cardReviewing.value).add(id);
	const props = {
		title,
		resolved,
		status: d.status || "",
		agentName: d.agentName || "",
		desc: d.description || "",
		undoSeconds: 10,
		draftId: id,
		onView: () => openSkillDraft(d.draftId),
		onKeep: () => armCardUndo(id, `Keeping ${d.skillName}…`, () => keepSkillDraft({
			id: d.draftId,
			agentGroupId: d.agentGroupId,
			agentName: d.agentName
		}, null)),
		onDiscard: () => armCardUndo(id, `Discarding ${d.skillName}…`, () => discardSkillDraft(d.draftId)),
		onUndo: () => clearCardUndo(id)
	};
	return {
		key: nextKey(),
		kind: "draft",
		id,
		payload: props
	};
}
function armCardUndo(id, label, commit) {
	const el = $(`#messages .skill-draft-msg[data-draft-id="${id}"] .skill-draft-actions`);
	const w = el ? el.getBoundingClientRect().width : 0;
	cardUndo.value = {
		...cardUndo.value,
		[id]: {
			label,
			width: w ? `${w}px` : "",
			commit: () => {
				clearCardUndo(id);
				commit();
			}
		}
	};
}
function clearCardUndo(id) {
	const next = { ...cardUndo.value };
	delete next[id];
	cardUndo.value = next;
}
async function refreshDraftBadge(known) {
	let n = known;
	if (typeof n !== "number") try {
		const res = await authFetch("/api/skill-drafts");
		n = res.ok ? ((await res.json()).drafts || []).length : 0;
	} catch {
		n = 0;
	}
	const dot = $("#learn-drafts-dot");
	const pill = $("#learn-drafts-count");
	if (dot) dot.hidden = n === 0;
	if (pill) {
		pill.hidden = n === 0;
		pill.textContent = n > 0 ? String(n) : "";
	}
}
var draftsApp = null;
function mountSkillDrafts() {
	if (draftsApp) return;
	const host = $("#skill-drafts-list");
	if (!host) return;
	draftsApp = createApp(SkillDrafts_default, {
		undoSeconds: 10,
		onOpen: (id) => openSkillDraft(id),
		onSource: (roomId) => {
			const room = state.lastRoomsList.find((r) => r.id === roomId);
			deps$8.joinRoom(roomId, room ? room.name : roomId);
		},
		onKeep: (r) => armDraftUndo(r.id, `Keeping ${r.raw.skillName}…`, () => keepSkillDraft(r.raw, null)),
		onDiscard: (r) => armDraftUndo(r.id, `Discarding ${r.raw.skillName}…`, () => discardSkillDraft(r.id)),
		onUndo: (id) => clearDraftUndo(id)
	});
	draftsApp.mount(host);
}
function armDraftUndo(id, label, commit) {
	const el = document.querySelector(`#skill-drafts-list li[data-draft-id="${CSS.escape(id)}"] .skill-draft-actions`);
	const w = el ? el.getBoundingClientRect().width : 0;
	draftUndo.value = {
		...draftUndo.value,
		[id]: {
			label,
			width: w ? `${w}px` : "",
			commit: () => {
				clearDraftUndo(id);
				commit();
			}
		}
	};
}
function clearDraftUndo(id) {
	const next = { ...draftUndo.value };
	delete next[id];
	draftUndo.value = next;
}
async function renderSkillDrafts() {
	const wrap = $("#skill-drafts");
	if (!wrap || !$("#skill-drafts-list")) return;
	let drafts = [];
	try {
		const res = await authFetch("/api/skill-drafts");
		if (res.ok) drafts = (await res.json()).drafts || [];
	} catch {}
	wrap.hidden = drafts.length === 0;
	refreshDraftBadge(drafts.length);
	skillDrafts.value = drafts;
	draftsReviewing.value = new Set([...reviewingDrafts].filter((id) => drafts.some((d) => d.id === id)));
	mountSkillDrafts();
}
var skillEditorDraft = null;
function openSkillEditorModal({ name, body, editable, badgeText, onSave, actions = [] }) {
	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	document.body.appendChild(overlay);
	let app = null;
	const close = () => {
		app?.unmount();
		app = null;
		overlay.remove();
	};
	app = createApp(SkillEditorModal_default, {
		name,
		body,
		editable: !!editable,
		badgeText: badgeText || "",
		actions,
		onSave: async (text) => {
			try {
				await onSave(text);
			} catch (err) {
				showToast("Save failed: " + (err?.message || err), { kind: "error" });
				throw err;
			}
		},
		onClose: close
	});
	app.mount(overlay);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});
}
async function openScopedSkillEditor(agentId, name) {
	let data = null;
	try {
		data = await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`);
	} catch (err) {
		return showToast("Couldn’t load skill: " + (err?.message || err), { kind: "error" });
	}
	openSkillEditorModal({
		name: data.name,
		body: data.body,
		editable: !!data.editable,
		badgeText: data.editable ? "learned · editable (this agent)" : "read-only",
		actions: [{
			label: "History",
			onClick: () => deps$8.openJourney({
				agentGroupId: agentId,
				skill: name
			})
		}],
		onSave: async (content) => {
			showToast(`Saved ${(await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}/content`, {
				method: "PUT",
				body: { content }
			})).name} — applies on this agent's next spawn`, { kind: "success" });
			if (selectedAgentId.value) renderAgentSkills(selectedAgentId.value);
		}
	});
}
async function openPoolSkillFromAgent(name) {
	let data = null;
	try {
		data = await apiJson(`/api/skills/${encodeURIComponent(name)}`);
	} catch (err) {
		return showToast("Couldn’t load skill: " + (err?.message || err), { kind: "error" });
	}
	const editable = data.source === "user";
	openSkillEditorModal({
		name: data.name,
		body: data.content,
		editable,
		badgeText: editable ? "imported · editable" : "built-in · read-only",
		onSave: async (content) => {
			showToast(`Saved ${(await apiJson(`/api/skills/${encodeURIComponent(name)}`, {
				method: "PUT",
				body: { content }
			})).name} — applies on each agent's next spawn`, { kind: "success" });
		}
	});
}
async function openSkillDraft(id) {
	try {
		const d = await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`);
		const isPatch = d.kind === "patch" && d.targetSkill;
		skillEditorDraft = {
			id: d.id,
			name: isPatch ? d.targetSkill : d.skillName,
			isPatch,
			body: d.body,
			currentBody: d.currentBody || "",
			mode: isPatch && d.currentBody ? "diff" : "edit"
		};
		const draft = skillEditorDraft;
		if ($("#manage").hidden || $("#mtab-skills").hidden) {
			deps$8.openManage("skills");
			setTimeout(() => {
				skillEditorDraft = draft;
				renderDraftEditor();
			}, 200);
		} else renderDraftEditor();
	} catch (err) {
		showToast("Could not open draft: " + (err?.message || err), { kind: "error" });
	}
}
function renderDraftEditor() {
	const d = skillEditorDraft;
	if (!d) return;
	const content = $("#skill-editor-content");
	$("#skill-editor-name").value = d.name;
	$("#skill-editor-name").readOnly = true;
	const badge = $("#skill-editor-badge");
	if (badge) {
		badge.hidden = false;
		badge.className = "skill-badge";
		badge.textContent = d.isPatch ? `proposed revision of ${d.name}` : "proposed skill";
	}
	const modeBtn = $("#skill-editor-mode");
	if (d.mode === "diff") {
		content.value = lineDiff(d.currentBody, d.body);
		content.readOnly = true;
		$("#skill-editor-save").hidden = true;
		if (modeBtn) {
			modeBtn.hidden = false;
			modeBtn.textContent = "Edit";
		}
	} else {
		content.value = d.body;
		content.readOnly = false;
		$("#skill-editor-save").hidden = false;
		if (modeBtn) {
			modeBtn.hidden = !(d.isPatch && d.currentBody);
			modeBtn.textContent = "View diff";
		}
	}
	showSkillEditor(true);
}
var reviewingDrafts = /* @__PURE__ */ new Set();
function draftKeepButton(draftId) {
	return document.querySelector(`button[data-draft-id="${CSS.escape(draftId)}"]`);
}
function markDraftReviewing(btn, reviewing) {
	if (!btn) return;
	btn.disabled = reviewing;
	btn.textContent = reviewing ? "Reviewing…" : "Keep";
}
function handleSkillDraftReview(msg) {
	reviewingDrafts.delete(msg.draftId);
	const d = {
		id: msg.draftId,
		skillName: msg.skillName,
		agentGroupId: msg.agentGroupId,
		agentName: msg.agentName
	};
	if (msg.outcome === "kept") {
		showToast(msg.updated ? `Updated ${msg.name || d.skillName} — wired to ${d.agentName}` : `Kept ${msg.name || d.skillName} — wired to ${d.agentName}`, { kind: "success" });
		refreshDraftBadge();
		renderSkillsRegistry();
		return;
	}
	markDraftReviewing(draftKeepButton(msg.draftId), false);
	if (msg.outcome === "overlaps" && Array.isArray(msg.overlaps) && msg.overlaps.length) {
		showOverlapChoice(d, msg.overlaps);
		return;
	}
	toastError(new Error(msg.error || "Review failed"), "Keep failed");
}
async function keepSkillDraft(d, btn, force, updateTarget) {
	if (btn) {
		btn.disabled = true;
		btn.textContent = updateTarget ? "Updating…" : "Keeping…";
	}
	try {
		const qs = updateTarget ? `?updateTarget=${encodeURIComponent(updateTarget)}` : force ? "?force=1" : "";
		const res = await authFetch(`/api/skill-drafts/${encodeURIComponent(d.id)}/keep${qs}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentGroupId: d.agentGroupId })
		});
		const body = await res.json().catch(() => ({}));
		if (res.status === 202 && body.queued) {
			reviewingDrafts.add(d.id);
			markDraftReviewing(btn, true);
			return;
		}
		if (!res.ok) throw new Error(body.error || res.statusText);
		showToast(body.updated ? `Updated ${body.name} — wired to ${d.agentName}` : `Kept ${body.name} — wired to ${d.agentName}`, { kind: "success" });
		refreshDraftBadge();
		renderSkillsRegistry();
	} catch (err) {
		toastError(err, "Keep failed");
		markDraftReviewing(btn, false);
	}
}
async function discardSkillDraft(id) {
	try {
		await apiJson(`/api/skill-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
		refreshDraftBadge();
		renderSkillDrafts();
	} catch (err) {
		showToast("Discard failed: " + (err?.message || err), { kind: "error" });
	}
}
async function renderSkillDuplicates() {
	const wrap = $("#skill-duplicates");
	const list = $("#skill-duplicates-list");
	if (!wrap || !list) return;
	let dups = [];
	try {
		const res = await authFetch("/api/skills/duplicates");
		if (res.ok) dups = (await res.json()).duplicates || [];
	} catch {}
	wrap.hidden = dups.length === 0;
	skillDuplicates.value = dups;
	mountSkillDuplicates();
}
var skillDuplicatesApp = null;
function mountSkillDuplicates() {
	if (skillDuplicatesApp) return;
	const host = $("#skill-duplicates-list");
	if (!host) return;
	skillDuplicatesApp = createApp(SkillDuplicates_default, { onPromote: (name) => void promoteSkill(name) });
	skillDuplicatesApp.mount(host);
}
/**
* The disable-on-click that used to live on the button element. Keyed by name
* in a pending set, because the row is a vnode now and there is no element to
* hold — but the guard itself matters: without it a double-click promotes twice.
*/
async function promoteSkill(name) {
	if (!await deps$8.showConfirmModal({
		title: `Promote ${name} to the shared pool?`,
		body: `The newest copy serves every agent; each agent's own copy moves to its archive.`,
		confirmLabel: "Promote"
	})) return;
	promotingSkills.value.add(name);
	try {
		await apiJson("/api/skills/promote", {
			method: "POST",
			body: { name }
		});
		showToast(`${name} promoted — shared with all agents`, { kind: "success" });
		renderSkillsRegistry();
	} catch (err) {
		showToast("Promote failed: " + (err?.message || err), { kind: "error" });
	} finally {
		promotingSkills.value.delete(name);
	}
}
function skillsSectionOpen(key) {
	const v = localStorage.getItem("skillsSectionOpen:" + key);
	return v === null ? key === "pool" : v === "1";
}
function setSkillsSectionOpen(key, open) {
	localStorage.setItem("skillsSectionOpen:" + key, open ? "1" : "0");
}
function skillsFilterQuery() {
	return ($("#skills-filter")?.value || "").trim().toLowerCase();
}
var registryApp = null;
function mountSkillsRegistry() {
	if (registryApp) return;
	const host = $("#skills-list");
	if (!host) return;
	registryApp = createApp(SkillsRegistry_default, {
		onOpen: (r) => r.source === "scoped" ? openScopedSkillEditor(r.agentGroupId, r.name) : openSkillEditor(r.name),
		onToggleSection: (key) => {
			if (skillsFilter.value) return;
			const next = new Set(skillsOpenSections.value);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			skillsOpenSections.value = next;
			setSkillsSectionOpen(key, next.has(key));
		},
		onDelete: (r) => r.source === "scoped" ? removeAgentScopedSkill(r.agentGroupId, r.name, null, renderSkillsRegistry) : deleteSkill(r.name),
		onHistory: (r) => deps$8.openJourney({
			agentGroupId: r.agentGroupId,
			agentName: r.agentName,
			skill: r.name
		}),
		onUpdate: (name) => void updateSkillFromSource(name)
	});
	registryApp.mount(host);
}
async function updateSkillFromSource(name) {
	if (!await deps$8.showConfirmModal({
		title: `Update ${name}?`,
		body: "Re-imports from its source at the latest commit. The current version is kept in history.",
		confirmLabel: "Update"
	})) return;
	skillUpdating.value = new Set(skillUpdating.value).add(name);
	try {
		const body = await apiJson(`/api/skills/${encodeURIComponent(name)}/update`, { method: "POST" });
		showToast(`Updated ${name}`, { kind: "success" });
		for (const w of body.warnings || []) showToast(`⚠ ${w}`, { kind: "error" });
		renderSkillsRegistry();
	} catch (err) {
		showToast("Update failed: " + (err?.message || err), { kind: "error" });
	} finally {
		const next = new Set(skillUpdating.value);
		next.delete(name);
		skillUpdating.value = next;
	}
}
/**
* Re-apply the filter. The island derives visibility from skillsFilter, so this
* only has to copy the box's value in — the DOM walk applySkillsSections did is
* gone with it.
*/
function applySkillsSections() {
	skillsFilter.value = skillsFilterQuery();
}
/**
* Which skills have newer commits upstream. Was markSkillUpdates(), which
* queried already-rendered rows and injected a button into each — an async pass
* reaching into rendered DOM, which is precisely what an island forbids.
*/
async function loadSkillUpdates() {
	let updates = [];
	try {
		const res = await authFetch("/api/skills/updates");
		if (res.ok) updates = (await res.json()).updates || [];
	} catch {}
	const map = {};
	for (const u of updates) if (u.hasUpdate) map[u.name] = true;
	skillUpdates.value = map;
}
async function renderSkillsRegistry() {
	if (!$("#skills-list")) return;
	showSkillEditor(false);
	renderSkillDrafts();
	renderSkillDuplicates();
	const learnLink = $("#skills-learn-link");
	if (learnLink) learnLink.hidden = !state.learningMasterEnabled;
	skillsPhase.value = "loading";
	mountSkillsRegistry();
	let skills = [];
	try {
		const res = await authFetch("/api/skills");
		if (res.ok) skills = (await res.json()).skills || [];
	} catch (err) {
		console.error("Failed to load skills:", err);
	}
	const filterEl = $("#skills-filter");
	if (!skills.length) {
		if (filterEl) filterEl.hidden = true;
		skillSections.value = [];
		skillsPhase.value = "empty";
		return;
	}
	if (filterEl) filterEl.hidden = false;
	const pool = [];
	const byAgent = /* @__PURE__ */ new Map();
	for (const s of skills) if (s.source === "scoped") {
		let g = byAgent.get(s.agentGroupId);
		if (!g) byAgent.set(s.agentGroupId, g = {
			name: s.agentName || "",
			rooms: s.rooms || [],
			skills: []
		});
		g.skills.push(s);
	} else pool.push(s);
	const shape = (s) => ({
		key: (s.source === "scoped" ? s.agentGroupId + ":" : "") + s.name,
		name: s.name ?? "",
		desc: s.description || "",
		badge: s.source === "scoped" ? {
			kind: "scope",
			text: s.rooms && s.rooms.length === 1 ? s.rooms[0].name : s.agentName
		} : s.source === "shipped" ? {
			kind: "shipped",
			text: "built-in"
		} : s.origin && s.origin.label ? {
			kind: "origin",
			origin: s.origin
		} : {
			kind: "imported",
			text: "imported"
		},
		extraOrigin: s.source === "scoped" && s.origin && s.origin.label ? s.origin : null,
		source: s.source,
		agentGroupId: s.agentGroupId,
		agentName: s.agentName,
		search: (s.name + " " + (s.description || "")).toLowerCase()
	});
	const sections = [];
	if (pool.length) sections.push({
		key: "pool",
		label: "Workspace",
		roomName: null,
		rows: pool.map(shape)
	});
	for (const [gid, g] of [...byAgent].sort((a, b) => a[1].name.localeCompare(b[1].name))) sections.push({
		key: gid,
		label: g.name,
		roomName: g.rooms.length === 1 ? g.rooms[0].name : null,
		rows: g.skills.map(shape)
	});
	skillSections.value = sections;
	skillsOpenSections.value = new Set(sections.filter((x) => skillsSectionOpen(x.key)).map((x) => x.key));
	skillsPhase.value = "ready";
	applySkillsSections();
	loadSkillUpdates();
}
var SKILL_TEMPLATE = `---
name: my-skill
description: One line saying what this skill is for and when to use it.
---

# My Skill

Instructions the agent follows when this skill applies.
`;
function showSkillsView(view) {
	$("#skills-browse").hidden = view !== "browse";
	$("#skills-add").hidden = view !== "add";
	$("#skills-editor").hidden = view !== "editor";
}
function resetSkillEditorState() {
	skillEditorDraft = null;
	const m = $("#skill-editor-mode");
	if (m) m.hidden = true;
}
var skillEditorClosing = false;
function showSkillEditor(show) {
	if (show) {
		skillEditorClosing = false;
		showSkillsView("editor");
		if (!viewStack.some((v) => v.name === "skill-editor")) deps$8.openView("skill-editor", () => {
			skillEditorClosing = false;
			resetSkillEditorState();
			showSkillsView("browse");
		});
		return;
	}
	if (viewStack.some((v) => v.name === "skill-editor")) {
		if (!skillEditorClosing) {
			skillEditorClosing = true;
			deps$8.closeView("skill-editor");
		}
		return;
	}
	resetSkillEditorState();
	showSkillsView("browse");
}
var skillTrust = "official";
var poolSeq = 0;
async function openSkillsAdd() {
	showSkillsView("add");
	$("#skill-discover-search").value = "";
	await setSkillTrust("official");
}
async function setSkillTrust(mode) {
	skillTrust = mode;
	const official = mode === "official";
	$("#skills-trust-official").classList.toggle("active", official);
	$("#skills-trust-official").setAttribute("aria-selected", String(official));
	$("#skills-trust-community").classList.toggle("active", !official);
	$("#skills-trust-community").setAttribute("aria-selected", String(!official));
	const search = $("#skill-discover-search");
	search.hidden = official;
	if (official) search.value = "";
	$("#skills-catalog-warn").hidden = official;
	await renderSkillPool();
}
var poolApp = null;
function mountSkillPool() {
	if (poolApp) return;
	const host = $("#skills-catalog-list");
	if (!host) return;
	poolApp = createApp(SkillPool_default, { onAdd: (s) => deps$8.openWireToAgentsPicker({
		...s.ref,
		origin: s.origin
	}, s.name, { community: skillPoolCommunity.value }) });
	poolApp.mount(host);
}
async function renderSkillPool() {
	if (!$("#skills-catalog-list")) return;
	const tier = skillTrust;
	const community = tier === "community";
	const q = community ? $("#skill-discover-search").value.trim() : "";
	const seq = ++poolSeq;
	skillPoolCommunity.value = community;
	skillPoolQuery.value = q;
	skillPoolPhase.value = "loading";
	mountSkillPool();
	let data = null;
	try {
		const res = await authFetch(`/api/skills/catalog?tier=${tier}&q=${encodeURIComponent(q)}`);
		if (res.ok) data = await res.json();
	} catch {}
	if (seq !== poolSeq) return;
	if (!data) {
		skillPool.value = [];
		skillPoolPhase.value = "error";
		return;
	}
	const skills = data.skills || [];
	skillPool.value = skills;
	skillPoolPhase.value = skills.length ? "ready" : "empty";
}
async function openSkillEditor(name) {
	skillEditorDraft = null;
	const modeBtn = $("#skill-editor-mode");
	if (modeBtn) modeBtn.hidden = true;
	const nameInput = $("#skill-editor-name");
	const content = $("#skill-editor-content");
	const badge = $("#skill-editor-badge");
	const save = $("#skill-editor-save");
	if (name) {
		let data = null;
		try {
			const res = await authFetch(`/api/skills/${encodeURIComponent(name)}`);
			if (res.ok) data = await res.json();
		} catch {}
		if (!data) return showToast("Couldn’t load skill", { kind: "error" });
		nameInput.value = data.name;
		nameInput.readOnly = true;
		content.value = data.content;
		const editable = data.source === "user";
		content.readOnly = !editable;
		save.hidden = !editable;
		badge.hidden = false;
		badge.className = "skill-badge skill-badge-" + data.source;
		badge.textContent = editable ? "imported — editable" : "built-in — read-only";
	} else {
		nameInput.value = "";
		nameInput.readOnly = false;
		content.value = SKILL_TEMPLATE;
		content.readOnly = false;
		save.hidden = false;
		badge.hidden = true;
	}
	showSkillEditor(true);
	(name ? content : nameInput).focus();
}
async function saveSkillEditor() {
	if (skillEditorDraft) {
		const d = skillEditorDraft;
		const body = d.mode === "edit" ? $("#skill-editor-content").value : d.body;
		const save = $("#skill-editor-save");
		save.disabled = true;
		try {
			await apiJson(`/api/skill-drafts/${encodeURIComponent(d.id)}`, {
				method: "PUT",
				body: { body }
			});
			d.body = body;
			showToast("Draft updated — Keep applies this version", { kind: "success" });
			renderSkillDrafts();
			renderRoomSkills();
		} catch (err) {
			showToast("Save failed: " + (err?.message || err), { kind: "error" });
		} finally {
			save.disabled = false;
		}
		return;
	}
	const name = $("#skill-editor-name").value.trim();
	const content = $("#skill-editor-content").value;
	if (!name) return showToast("Give the skill a name", { kind: "error" });
	const save = $("#skill-editor-save");
	save.disabled = true;
	try {
		showToast(`Saved ${(await apiJson(`/api/skills/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: { content }
		})).name} — applies on each agent's next spawn`, { kind: "success" });
		showSkillEditor(false);
		await renderSkillsRegistry();
	} catch (err) {
		showToast("Save failed: " + (err?.message || err), { kind: "error" });
	} finally {
		save.disabled = false;
	}
}
var skillSourcesApp = null;
function mountSkillSources() {
	if (skillSourcesApp) return;
	const host = $("#skill-sources-list");
	if (!host) return;
	skillSourcesApp = createApp(SkillSources_default, {
		onEdit: (r) => {
			const s = r.raw;
			$("#skill-source-url").value = `https://github.com/${s.owner}/${s.repo}/tree/${s.branch}/${s.dir}`;
			const save = $("#skill-source-save");
			save.textContent = "Save";
			save.dataset.editId = s.id;
		},
		onRemove: async (r) => {
			if (!await deps$8.showConfirmModal({
				title: `Remove ${r.origin.label}?`,
				body: "The collection disappears from the Skills catalog. Already-imported skills are unaffected.",
				confirmLabel: "Remove",
				destructive: true
			})) return;
			try {
				await apiJson(`/api/skills/sources/${encodeURIComponent(r.raw.id)}`, { method: "DELETE" });
				renderSkillSources();
			} catch (err) {
				showToast("Remove failed: " + (err?.message || err), { kind: "error" });
			}
		},
		onToggleBuiltin: (r) => toggleBuiltinSource(r.raw.id, r.disabled)
	});
	skillSourcesApp.mount(host);
}
/** The catalog's sources — rendered on the Skills TAB, beside what they feed. */
async function renderSkillSources() {
	const section = $("#skill-sources");
	if (!section) return;
	section.hidden = !state.isOwnerView;
	if (!state.isOwnerView) return;
	let sources = [];
	let builtins = [];
	try {
		const res = await authFetch("/api/skills/sources");
		if (res.ok) {
			const b = await res.json();
			sources = b.sources || [];
			builtins = b.builtins || [];
		}
	} catch {}
	skillSources.value = [...sources.map((s) => ({
		key: "src:" + s.id,
		kind: "source",
		origin: s.official ? {
			label: s.label.replace(/\s*\((?:official|community)\)\s*$/i, ""),
			url: `https://github.com/${s.owner}/${s.repo}`,
			official: true
		} : {
			label: `${s.owner}/${s.repo}`,
			url: `https://github.com/${s.owner}/${s.repo}`,
			official: false
		},
		meta: s.dir ? `${s.dir} · ${s.branch}` : `whole repo · ${s.branch}`,
		disabled: false,
		raw: s
	})), ...builtins.map((bi) => ({
		key: "bi:" + bi.id,
		kind: "builtin",
		origin: {
			label: bi.label,
			url: bi.url,
			official: false
		},
		meta: bi.disabled ? "Built-in marketplace — removed from the pool" : "Built-in marketplace — pooled into Community",
		disabled: !!bi.disabled,
		raw: bi
	}))];
	mountSkillSources();
}
function importSkill() {
	const input = $("#skill-import-url");
	const url = (input.value || "").trim();
	if (!url) return;
	const label = url.replace(/^https?:\/\/github\.com\//, "").replace(/\/tree\/.*$/, "");
	input.value = "";
	deps$8.openWireToAgentsPicker({ url }, label || "skill", { community: true });
}
async function deleteSkill(name) {
	if (!await deps$8.showConfirmModal({
		title: `Delete ${name}?`,
		body: "Removes this imported skill. Agents that use it lose it on their next spawn.",
		confirmLabel: "Delete",
		destructive: true
	})) return;
	try {
		await apiJson(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
		showToast(`Deleted ${name}`, { kind: "success" });
		await renderSkillsRegistry();
	} catch (err) {
		showToast("Delete failed: " + (err?.message || err), { kind: "error" });
	}
}
var agentSkillsApp = null;
var currentAgentSkillsId = null;
function mountAgentSkillsList() {
	if (agentSkillsApp) return;
	const host = $("#agent-skills-list");
	if (!host) return;
	agentSkillsApp = createApp(AgentSkillsList_default, {
		onView: (name) => openPoolSkillFromAgent(name),
		onDirty: () => {
			const saveBtn = $("#agent-skills-save");
			if (saveBtn) saveBtn.disabled = false;
		}
	});
	agentSkillsApp.mount(host);
}
async function renderAgentSkills(agentId) {
	currentAgentSkillsId = agentId;
	const saveBtn = $("#agent-skills-save");
	let data = {
		available: [],
		enabled: []
	};
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/skills`);
		if (res.ok) data = await res.json();
	} catch (err) {
		console.error("Failed to load skills:", err);
	}
	const enabled = new Set(data.enabled || []);
	const scoped = data.scoped || [];
	const count = $("#agent-skills-count");
	if (count) count.textContent = enabled.size + scoped.length ? String(enabled.size + scoped.length) : "";
	if (saveBtn) saveBtn.disabled = true;
	renderAgentScopedSkills(agentId, scoped);
	agentSkillsEnabled.value = enabled;
	agentSkillRows.value = data.available || [];
	mountAgentSkillsList();
	if (saveBtn) saveBtn.onclick = () => saveAgentSkills(currentAgentSkillsId);
}
function renderAgentScopedSkills(agentId, scoped) {
	const list = $("#agent-scoped-list");
	const addBtn = $("#agent-scoped-add");
	const urlInput = $("#agent-scoped-url");
	if (!list) return;
	scopedSkillsAgentId = agentId;
	agentScopedSkills.value = scoped ?? [];
	mountAgentScopedSkills();
	if (addBtn) addBtn.onclick = () => importAgentScopedSkill(agentId, addBtn, urlInput);
}
var agentScopedApp = null;
/**
* Whose scoped skills are mounted. Read by the callbacks rather than captured:
* the app is created once and the agent panel is reopened for other agents.
*/
var scopedSkillsAgentId = null;
function mountAgentScopedSkills() {
	if (agentScopedApp) return;
	const host = $("#agent-scoped-list");
	if (!host) return;
	agentScopedApp = createApp(AgentScopedSkills_default, {
		onOpen: (name) => openScopedSkillEditor(scopedSkillsAgentId, name),
		onRemove: (name, el) => removeAgentScopedSkill(scopedSkillsAgentId, name, el)
	});
	agentScopedApp.mount(host);
}
async function importAgentScopedSkill(agentId, btn, urlInput) {
	const url = (urlInput?.value || "").trim();
	if (!url) return showToast("Paste a GitHub repo or folder URL", { kind: "error" });
	btn.disabled = true;
	btn.textContent = "Importing…";
	try {
		showToast(`Wired ${(await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/import`, {
			method: "POST",
			body: { url }
		})).name} to this agent — applies on its next turn`, { kind: "success" });
		if (urlInput) urlInput.value = "";
		renderAgentSkills(agentId);
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.textContent = "Import";
	}
}
async function removeAgentScopedSkill(agentId, name, btn, onDone) {
	if (!await deps$8.showConfirmModal({
		title: `Remove ${name}?`,
		body: "Unwires it from this agent.",
		confirmLabel: "Remove",
		destructive: true
	})) return;
	btn.disabled = true;
	try {
		await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills/scoped/${encodeURIComponent(name)}`, { method: "DELETE" });
		showToast(`Removed ${name}`, { kind: "success" });
		if (onDone) onDone();
		else renderAgentSkills(agentId);
	} catch (err) {
		showToast("Remove failed: " + (err?.message || err), { kind: "error" });
		btn.disabled = false;
	}
}
async function saveAgentSkills(agentId) {
	const saveBtn = $("#agent-skills-save");
	const skills = [...document.querySelectorAll("#agent-skills-list .agent-skill-toggle")].filter((t) => t.checked).map((t) => t.dataset.skill);
	if (saveBtn) saveBtn.disabled = true;
	try {
		showToast((await apiJson(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
			method: "PUT",
			body: { skills }
		})).restarted ? "Skills saved — agent restarting" : "Skills saved (applies on next message)", { kind: "success" });
		await renderAgentSkills(agentId);
	} catch (err) {
		showToast("Couldn’t save skills: " + (err?.message || err), { kind: "error" });
		if (saveBtn) saveBtn.disabled = false;
	}
}
var suggestTimer = null;
var suggestSeq = 0;
function scheduleSkillSuggest() {
	clearTimeout(suggestTimer);
	suggestTimer = setTimeout(refreshSkillSuggestions, 700);
}
var suggestApp = null;
function mountSkillSuggestions() {
	if (suggestApp) return;
	const host = $("#agent-create-skills-list");
	if (!host) return;
	suggestApp = createApp(SkillSuggestions_default);
	suggestApp.mount(host);
}
async function refreshSkillSuggestions() {
	const text = [
		$("#agent-create-draft-prompt").value,
		$("#agent-create-name").value,
		$("#agent-create-instructions").value
	].join(" ").trim();
	const block = $("#agent-create-skills");
	if (text.length < 12) {
		block.hidden = true;
		return;
	}
	const seq = ++suggestSeq;
	let suggestions = [];
	try {
		const res = await authFetch(`/api/skills/suggest?text=${encodeURIComponent(text.slice(0, 2e3))}`);
		if (res.ok) suggestions = (await res.json()).suggestions || [];
	} catch {}
	if (seq !== suggestSeq) return;
	if (!suggestions.length) {
		skillSuggestions.value = [];
		block.hidden = true;
		return;
	}
	skillSuggestions.value = suggestions;
	mountSkillSuggestions();
	block.hidden = false;
}
var DRAFTER_TARGETS = {
	"agent-create": {
		prompt: "#agent-create-draft-prompt",
		name: "#agent-create-name",
		instructions: "#agent-create-instructions"
	},
	"room-create": {
		prompt: "#room-create-draft-prompt",
		name: "#room-create-new-name",
		instructions: "#room-create-new-instructions"
	},
	"room-add-agent": {
		prompt: "#room-add-agent-draft-prompt",
		name: "#room-add-agent-new-name",
		instructions: "#room-add-agent-new-instructions"
	}
};
async function draftFor(btn) {
	const target = DRAFTER_TARGETS[btn.dataset.drafterTarget];
	if (!target) return;
	const promptEl = $(target.prompt);
	const nameEl = $(target.name);
	const instructionsEl = $(target.instructions);
	const prompt = (promptEl?.value || "").trim();
	if (!prompt) {
		showToast("Type a description first, e.g. \"An agent that helps me draft replies to emails\".", { kind: "error" });
		return;
	}
	const original = btn.innerHTML;
	btn.disabled = true;
	btn.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> Drafting…";
	try {
		const res = await authFetch("/api/agents/draft", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt })
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok) {
			showToast("Drafter failed: " + (body.error || res.statusText), { kind: "error" });
			return;
		}
		if (nameEl) nameEl.value = body.name || "";
		if (instructionsEl) instructionsEl.value = body.instructions || "";
		nameEl?.focus();
		nameEl?.select();
	} catch (err) {
		showToast("Drafter failed: " + err?.message, { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.innerHTML = original;
	}
}
var roomSkillsApp = null;
function mountRoomSkills() {
	if (roomSkillsApp) return;
	const host = $("#room-skills-list");
	if (!host) return;
	roomSkillsApp = createApp(RoomSkills_default, {
		undoSeconds: 10,
		onView: (id) => openSkillDraft(id),
		onKeep: (r) => armRoomSkillUndo(r.id, `Keeping ${r.skillName}…`, async () => {
			await keepSkillDraft({
				id: r.id,
				agentGroupId: r.agentGroupId,
				agentName: r.agentName
			}, null);
			renderRoomSkills();
		}),
		onDiscard: (r) => armRoomSkillUndo(r.id, `Discarding ${r.skillName}…`, async () => {
			await discardSkillDraft(r.id);
			renderRoomSkills();
		}),
		onUndo: (id) => clearRoomSkillUndo(id),
		onRevert: async (r) => {
			if (!await deps$8.showConfirmModal({
				title: `Revert ${r.name}?`,
				body: "Back to the previous revision. The current version stays in history — a revert can itself be reverted.",
				confirmLabel: "Revert"
			})) return;
			try {
				const res = await authFetch(`/api/agents/${encodeURIComponent(r.agentId)}/skills/scoped/${encodeURIComponent(r.name)}/revert`, { method: "POST" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				showToast(`Reverted ${r.name}`);
				renderRoomSkills();
			} catch (err) {
				toastError(err, "Could not revert");
			}
		},
		onRemove: async (r) => {
			if (!await deps$8.showConfirmModal({
				title: `Remove ${r.name}?`,
				body: `It will no longer be available to ${r.agentLabel}.`,
				confirmLabel: "Remove",
				destructive: true
			})) return;
			try {
				const res = await authFetch(`/api/agents/${encodeURIComponent(r.agentId)}/skills/scoped/${encodeURIComponent(r.name)}`, { method: "DELETE" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				showToast(`Removed ${r.name}`);
				renderRoomSkills();
			} catch (err) {
				toastError(err, "Failed to remove skill");
			}
		},
		onRestore: async (r) => {
			try {
				const res = await authFetch(`/api/agents/${encodeURIComponent(r.agentId)}/skills/archived/${encodeURIComponent(r.name)}/restore`, { method: "POST" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
				showToast(`Restored ${r.name}`);
				renderRoomSkills();
			} catch (err) {
				toastError(err, "Could not restore");
			}
		}
	});
	roomSkillsApp.mount(host);
}
function armRoomSkillUndo(id, label, commit) {
	const el = document.querySelector(`#room-skills-list li[data-draft-id="${CSS.escape(id)}"] .room-skill-actions`) ?? document.querySelector(`#room-skills-list .room-skill-actions`);
	const w = el ? el.getBoundingClientRect().width : 0;
	roomSkillUndo.value = {
		...roomSkillUndo.value,
		[id]: {
			label,
			width: w ? `${w}px` : "",
			commit: () => {
				clearRoomSkillUndo(id);
				commit();
			}
		}
	};
}
function clearRoomSkillUndo(id) {
	const next = { ...roomSkillUndo.value };
	delete next[id];
	roomSkillUndo.value = next;
}
async function renderRoomSkills() {
	const section = $("#room-skills-section");
	if (!section || !$("#room-skills-list")) return;
	const count = $("#room-skills-count");
	const agents = roomDetailWiredAgents.value.slice();
	if (agents.length === 0) {
		section.hidden = true;
		return;
	}
	const ids = new Set(agents.map((a) => a.id));
	const nameOf = (id) => agents.find((a) => a.id === id)?.name || "agent";
	let drafts = [];
	let learned = [];
	let archived = [];
	try {
		const [draftRes, ...skillRes] = await Promise.all([authFetch("/api/skill-drafts"), ...agents.map((a) => authFetch(`/api/agents/${encodeURIComponent(a.id)}/skills`))]);
		drafts = ((await draftRes.json()).drafts || []).filter((d) => ids.has(d.agentGroupId));
		(await Promise.all(skillRes.map((r) => r.json().catch(() => ({}))))).forEach((payload, i) => {
			for (const s of payload.scoped || []) learned.push({
				...s,
				agentId: agents[i].id
			});
			for (const s of payload.archived || []) archived.push({
				...s,
				agentId: agents[i].id
			});
		});
	} catch (err) {
		console.error("Failed to load room skills:", err);
		section.hidden = true;
		return;
	}
	section.hidden = false;
	count.textContent = drafts.length + learned.length ? String(drafts.length + learned.length) : "";
	renderDistillButton(agents);
	roomSkillsReviewing.value = new Set([...reviewingDrafts].filter((id) => drafts.some((d) => d.id === id)));
	roomSkillRows.value = [
		...drafts.map((d) => ({
			kind: "proposed",
			key: "d:" + d.id,
			id: d.id,
			skillName: d.skillName,
			agentGroupId: d.agentGroupId,
			agentName: d.agentName,
			name: d.kind === "patch" ? `Change to ${d.targetSkill || d.skillName}` : d.skillName,
			origin: {
				label: `proposed · ${d.agentName || nameOf(d.agentGroupId)}`,
				official: false
			},
			desc: d.description || "",
			keepTitle: `Wire to ${d.agentName || nameOf(d.agentGroupId)}`
		})),
		...learned.map((s) => ({
			kind: "learned",
			key: "l:" + s.agentId + ":" + s.name,
			name: s.name ?? "",
			origin: s.origin || null,
			who: agents.length > 1 ? nameOf(s.agentId) : "",
			uses: s.invocations > 0 ? `used ${s.invocations}×` : "",
			hasHistory: !!s.hasHistory,
			agentId: s.agentId,
			agentLabel: nameOf(s.agentId),
			removeTitle: `Remove from ${nameOf(s.agentId)}`
		})),
		...archived.map((s) => ({
			kind: "archived",
			key: "a:" + s.agentId + ":" + s.name,
			name: s.name ?? "",
			agentId: s.agentId
		}))
	];
	mountRoomSkills();
}
function renderDistillButton(agents) {
	const host = $("#room-skills-section .form-label-row");
	const existing = $("#room-distill-btn");
	if (existing) existing.remove();
	if (!host || !agents.length || selectedRoomId.value !== state.currentRoom) return;
	const btn = document.createElement("button");
	btn.id = "room-distill-btn";
	btn.type = "button";
	btn.className = "btn btn-secondary";
	btn.textContent = "Distill a skill…";
	btn.title = "Review this session and draft a skill if it taught something worth keeping";
	btn.addEventListener("click", () => {
		deps$8.closeRoomDetail();
		deps$8.triggerLearn();
	});
	host.appendChild(btn);
}
var poolSearchTimer;
var skillsFilterTimer;
function wireSkillsPanel() {
	$("#skill-editor-mode")?.addEventListener("click", () => {
		const d = getSkillEditorDraft();
		if (!d) return;
		if (d.mode === "edit") {
			const ta = $("#skill-editor-content");
			if (ta) d.body = ta.value;
			d.mode = "diff";
		} else d.mode = "edit";
		renderDraftEditor();
	});
	$("#skill-add-btn")?.addEventListener("click", openSkillsAdd);
	$("#skill-discover-search")?.addEventListener("input", () => {
		clearTimeout(poolSearchTimer);
		poolSearchTimer = setTimeout(() => renderSkillPool(), 400);
	});
	$("#skills-add-back")?.addEventListener("click", () => renderSkillsRegistry());
	$("#skills-filter")?.addEventListener("input", () => {
		clearTimeout(skillsFilterTimer);
		skillsFilterTimer = setTimeout(applySkillsSections, 100);
	});
	$("#skills-trust-official")?.addEventListener("click", () => setSkillTrust("official"));
	$("#skills-trust-community")?.addEventListener("click", () => setSkillTrust("community"));
	$("#skills-learn-link")?.addEventListener("click", async () => {
		const v = await promptLearnSource({
			title: "Learn from a link",
			placeholder: "https://…",
			check: isLearnUrlToken,
			invalid: "Start with a full link (http:// or https://)"
		});
		if (!v) return;
		const room = await pickLearnTarget();
		if (!room) return;
		closeView("manage");
		joinRoom(room.id, room.name);
		state.pendingSendAfterJoin = "/learn " + v;
	});
	const sourceSaveBtn = $("#skill-source-save");
	const sourceUrlInput = $("#skill-source-url");
	sourceSaveBtn?.addEventListener("click", async () => {
		const save = sourceSaveBtn;
		const url = sourceUrlInput?.value.trim() ?? "";
		if (!url) return showToast("Paste a GitHub repo or folder URL", { kind: "error" });
		const folder = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
		const root = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
		const derivedId = (folder ? `${folder[1]}-${folder[2]}-${folder[4]}` : root ? `${root[1]}-${root[2]}` : "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
		const id = save.dataset.editId || derivedId;
		if (!id) return showToast("Expected a GitHub repo or folder URL", { kind: "error" });
		save.disabled = true;
		try {
			showToast(`Added ${(await apiJson(`/api/skills/sources/${encodeURIComponent(id)}`, {
				method: "PUT",
				body: { url }
			})).source?.label || "collection"}`, { kind: "success" });
			if (sourceUrlInput) sourceUrlInput.value = "";
			save.textContent = "Add";
			delete save.dataset.editId;
			renderSkillSources();
		} catch (err) {
			showToast("Save failed: " + (err?.message || err), { kind: "error" });
		} finally {
			save.disabled = false;
		}
	});
	$("#skill-new-btn")?.addEventListener("click", () => openSkillEditor(null));
	$("#skill-editor-cancel")?.addEventListener("click", () => showSkillEditor(false));
	$("#skill-editor-save")?.addEventListener("click", saveSkillEditor);
	$("#skill-import-btn")?.addEventListener("click", importSkill);
	$("#skill-import-url")?.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			importSkill();
		}
	});
}
function wireSkillsRegistry() {
	$("#agent-create-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const name = ($("#agent-create-name")?.value ?? "").trim();
		if (!name) return;
		const instructions = $("#agent-create-instructions")?.value ?? "";
		try {
			const res = await authFetch("/api/agents", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					instructions: instructions || void 0
				})
			});
			if (!res.ok) {
				showToast("Failed to create agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
				return;
			}
			const checked = [...document.querySelectorAll("#agent-create-skills-list .agent-create-skill-check:checked")];
			if (checked.length) showToast(`Adding ${checked.length} suggested skill(s)…`, { kind: "info" });
			for (const c of checked) try {
				await apiJson("/api/skills/import", {
					method: "POST",
					body: { url: c.dataset.url }
				});
				showToast(`Added skill ${c.dataset.name}`, { kind: "success" });
			} catch (err) {
				showToast(`Skill ${c.dataset.name} failed: ` + (err?.message || err), { kind: "error" });
			}
			const skillsWrap = $("#agent-create-skills");
			const skillsList = $("#agent-create-skills-list");
			if (skillsWrap) skillsWrap.hidden = true;
			if (skillsList) skillsList.innerHTML = "";
			await fetchAgents();
			closeAgentDetail();
		} catch (err) {
			showToast("Failed to create agent: " + err.message, { kind: "error" });
		}
	});
}
async function showOverlapChoice(d, overlaps) {
	const el = document.createElement("div");
	for (const o of overlaps) {
		const row = document.createElement("div");
		row.className = "import-warning";
		row.textContent = `⚠ ${o.name} (${o.source === "pending-draft" ? "pending draft" : o.source}) — ${o.reason}`;
		el.appendChild(row);
	}
	const updatable = overlaps.filter((o) => o.source !== "pending-draft");
	let confirmLabel;
	let confirmDecision;
	const extras = [];
	if (updatable.length === 1) {
		confirmLabel = `Update ${updatable[0].name}`;
		confirmDecision = {
			action: "update",
			target: updatable[0].name
		};
		extras.push({
			label: "Keep as new",
			value: { action: "keep-new" },
			className: "btn btn-secondary"
		});
	} else {
		confirmLabel = "Keep as new";
		confirmDecision = { action: "keep-new" };
		for (const o of updatable.slice(0, 3)) extras.push({
			label: `Update ${o.name}`,
			value: {
				action: "update",
				target: o.name
			},
			className: "btn btn-secondary"
		});
	}
	extras.push({
		label: "Discard draft",
		value: { action: "discard" },
		className: "btn btn-danger"
	});
	const choice = await showConfirmModal({
		title: `Overlaps with ${overlaps.length === 1 ? overlaps[0].name : overlaps.length + " existing skills"}`,
		body: el,
		confirmLabel,
		extraActions: extras
	});
	const decision = choice === true ? confirmDecision : choice || { action: "cancel" };
	if (decision.action === "update") return keepSkillDraft(d, draftKeepButton(d.id), false, decision.target);
	if (decision.action === "keep-new") return keepSkillDraft(d, draftKeepButton(d.id), true);
	if (decision.action === "discard") {
		await discardSkillDraft(d.id);
		showToast(`Discarded ${d.skillName || "draft"}`, { kind: "success" });
	}
}
function lineDiff(oldText, newText) {
	const a = String(oldText).split("\n");
	const b = String(newText).split("\n");
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) if (a[i] === b[j]) {
		out.push("  " + a[i]);
		i++;
		j++;
	} else if (dp[i + 1][j] >= dp[i][j + 1]) out.push("- " + a[i++]);
	else out.push("+ " + b[j++]);
	while (i < m) out.push("- " + a[i++]);
	while (j < n) out.push("+ " + b[j++]);
	return out.join("\n");
}
async function toggleBuiltinSource(id, wasDisabled) {
	try {
		const res = await authFetch(`/api/skills/sources/${encodeURIComponent(id)}`, {
			method: wasDisabled ? "PUT" : "DELETE",
			...wasDisabled ? {
				headers: { "Content-Type": "application/json" },
				body: "{}"
			} : {}
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
		showToast(wasDisabled ? "Marketplace added back to the pool" : "Marketplace removed from the pool", { kind: "success" });
		renderSkillSources();
	} catch (err) {
		showToast("Failed: " + (err?.message || err), { kind: "error" });
	}
}
//#endregion
//#region src/features/usage-state.ts
/** Per-user rows, already formatted into display strings. */
var usageRows = ref([]);
/** Per-day bars: height in px and a title. Empty means the sparkline is hidden. */
var usageBars = ref([]);
/** Per-model chips, already formatted. */
var usageModels = ref([]);
//#endregion
//#region src/features/UsageTable.vue
var UsageTable_default = /* @__PURE__ */ defineComponent({
	__name: "UsageTable",
	setup(__props) {
		/**
		* Per-user token usage rows — forty-second island.
		*
		* Mounted into <tbody id="usage-tbody">. The table's own hidden flag and
		* #usage-empty are outside it and stay imperative — they swap the whole table
		* for an empty note, which is a decision about the section, not the rows.
		*
		* Every cell but the first carries .usage-num (right-aligned numerics); the
		* first is the user handle. Shaped upstream so the component holds no
		* formatting rules.
		*/
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(usageRows), (r, i) => {
				return openBlock(), createElementBlock("tr", { key: i }, [(openBlock(true), createElementBlock(Fragment, null, renderList(r.cells, (c, j) => {
					return openBlock(), createElementBlock("td", mergeProps({ key: j }, { ref_for: true }, j > 0 ? { class: "usage-num" } : {}), toDisplayString(c ?? ""), 17);
				}), 128))]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/UsageSpark.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$11 = ["title"];
//#endregion
//#region src/features/UsageSpark.vue
var UsageSpark_default = /* @__PURE__ */ defineComponent({
	__name: "UsageSpark",
	setup(__props) {
		/**
		* The per-day usage sparkline — forty-third island.
		*
		* Mounted into <div id="usage-spark">. Its hidden flag stays imperative: the
		* sparkline is suppressed entirely below two days of data, which is a decision
		* about whether to show the element at all.
		*
		* Bar heights are computed upstream against the range's max, with a 4px floor
		* so a near-zero day is still visible.
		*/
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(usageBars), (b, i) => {
				return openBlock(), createElementBlock("span", {
					key: i,
					class: "usage-bar",
					style: normalizeStyle({ height: b.height }),
					title: b.title
				}, null, 12, _hoisted_1$11);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/UsageModels.vue
var UsageModels_default = /* @__PURE__ */ defineComponent({
	__name: "UsageModels",
	setup(__props) {
		/**
		* Model-breakdown chips — forty-fourth island.
		*
		* Mounted into <div id="usage-models">. Attribution is via each room's agent's
		* CURRENT model, so the chips describe where tokens went, not what was in
		* effect at the time.
		*/
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(usageModels), (m, i) => {
				return openBlock(), createElementBlock("span", {
					key: i,
					class: "usage-model-chip"
				}, toDisplayString(m), 1);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/matrix-state.ts
var matrixRooms = ref([]);
var matrixAgents = ref([]);
/** "roomId|agentId" for every wired pair — the same key shape legacy uses. */
var matrixEdges = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/WiringMatrix.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$10 = {
	key: 1,
	class: "matrix-table"
};
var _hoisted_2$7 = { class: "matrix-agent-name" };
var _hoisted_3$7 = { class: "matrix-room-head" };
var _hoisted_4$4 = [
	"data-room",
	"data-agent",
	"title"
];
var EMPTY$2 = "Nothing to wire yet — create a room and an agent first.";
var CORNER = "Room \\ Agent";
var NO_MODEL = "no model";
//#endregion
//#region src/features/WiringMatrix.vue
var WiringMatrix_default = /* @__PURE__ */ defineComponent({
	__name: "WiringMatrix",
	setup(__props) {
		/**
		* The room ↔ agent wiring matrix — thirty-ninth island.
		*
		* Mounted into <div id="matrix-canvas">, exclusively owned by this module.
		*
		* The cells carry data-room and data-agent and are NOT wired here. A delegated
		* click handler on the canvas reads those attributes and toggles the edge —
		* one listener for a grid that can be rooms × agents cells, which is why it was
		* delegated in the first place. Putting @click on every cell would multiply the
		* listener count by the grid size, and the listener-set guard would be right to
		* flag it.
		*
		* The empty state replaces the whole table, as before: a matrix with no rooms
		* or no agents has nothing to render, not an empty grid.
		*/
		const empty = computed(() => matrixRooms.value.length === 0 || matrixAgents.value.length === 0);
		const isOn = (roomId, agentId) => matrixEdges.value.has(`${roomId}|${agentId}`);
		return (_ctx, _cache) => {
			return empty.value ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createTextVNode(toDisplayString(EMPTY$2))], 64)) : (openBlock(), createElementBlock("table", _hoisted_1$10, [createElementVNode("thead", null, [createElementVNode("tr", null, [createElementVNode("th", { class: "matrix-corner" }, toDisplayString(CORNER)), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(matrixAgents), (a) => {
				return openBlock(), createElementBlock("th", {
					key: a.id,
					class: "matrix-agent-head"
				}, [createElementVNode("div", _hoisted_2$7, toDisplayString(a.name), 1), createElementVNode("div", { class: normalizeClass(a.modelName ? "matrix-model-chip" : "matrix-model-chip none") }, toDisplayString(a.modelName || NO_MODEL), 3)]);
			}), 128))])]), createElementVNode("tbody", null, [(openBlock(true), createElementBlock(Fragment, null, renderList(unref(matrixRooms), (room) => {
				return openBlock(), createElementBlock("tr", { key: room.id }, [createElementVNode("th", _hoisted_3$7, toDisplayString(room.name), 1), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(matrixAgents), (a) => {
					return openBlock(), createElementBlock("td", {
						key: a.id,
						class: normalizeClass(isOn(room.id, a.id) ? "matrix-cell on" : "matrix-cell"),
						"data-room": room.id,
						"data-agent": a.id,
						title: `${room.name} ↔ ${a.name}`
					}, null, 10, _hoisted_4$4);
				}), 128))]);
			}), 128))])]));
		};
	}
});
//#endregion
//#region src/features/JourneyList.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$9 = {
	key: 2,
	class: "journey-empty"
};
var _hoisted_2$6 = ["hidden"];
var _hoisted_3$6 = [
	"data-kind",
	"data-agent",
	"data-skill",
	"hidden",
	"title",
	"onClick",
	"onKeydown"
];
var _hoisted_4$3 = { class: "journey-skill" };
var _hoisted_5$2 = { class: "skill-badge skill-badge-scope" };
var _hoisted_6$2 = { class: "journey-meta" };
var _hoisted_7$2 = { class: "journey-time" };
var _hoisted_8$1 = ["onClick"];
var LOADING$1 = "Loading…";
var FAILED = "Could not load the timeline.";
var EMPTY$1 = "Nothing learned yet.";
var REVERT = "Revert";
//#endregion
//#region src/features/JourneyList.vue
var JourneyList_default = /* @__PURE__ */ defineComponent({
	__name: "JourneyList",
	props: {
		verbs: {},
		meta: { type: Function },
		onOpen: { type: Function },
		onRevert: { type: Function }
	},
	setup(__props) {
		/**
		* The learning-journey timeline — fortieth island.
		*
		* Mounted into <div id="journey-list">, exclusively owned by this module. The
		* filter CONTROLS (#journey-agent-filter, the kind buttons, #journey-skill-chip)
		* live outside it and stay imperative; only the list itself converts.
		*
		* Day headers were emitted inline while appending, using a journeyLastDay
		* variable that persisted across pagination calls. Derived from the full event
		* list here instead — which is why 'Load more' can append to a ref rather than
		* having to remember where the previous page stopped.
		*
		* Visibility is `hidden`, not v-if, exactly as applyJourneyFilters set it: rows
		* stay in the DOM and a day header hides only when every row under it is
		* hidden. #journey-no-match is outside the mount point and driven by the same
		* derived counts.
		*/
		const props = __props;
		const visible = (ev) => {
			const f = journeyFilter.value;
			return (!f.agent || (ev.agentGroupId || "") === f.agent) && (!f.kind || ev.kind === f.kind) && (!f.skill || (ev.skillName || "") === f.skill);
		};
		/** Events grouped under their day header, in load order. */
		const days = computed(() => {
			const now = /* @__PURE__ */ new Date();
			const out = [];
			let last = "";
			for (const ev of journeyEvents.value) {
				const d = new Date(ev.ts);
				const day = d.toDateString();
				if (day !== last) {
					last = day;
					out.push({
						key: day,
						label: day === now.toDateString() ? "Today" : d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? {
							month: "long",
							day: "numeric"
						} : {
							year: "numeric",
							month: "long",
							day: "numeric"
						}),
						rows: []
					});
				}
				out[out.length - 1].rows.push({
					ev,
					key: `${ev.ts}:${ev.kind}:${ev.skillName}`,
					verb: props.verbs[ev.kind] || ev.kind,
					meta: props.meta(ev),
					time: d.toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit"
					}),
					linked: (ev.kind === "kept" || ev.kind === "revised") && !!ev.skillExists
				});
			}
			return out;
		});
		function onKey(e, ev) {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				props.onOpen(ev);
			}
		}
		return (_ctx, _cache) => {
			return unref(journeyPhase) === "loading" ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createTextVNode(toDisplayString(LOADING$1))], 64)) : unref(journeyPhase) === "error" ? (openBlock(), createElementBlock(Fragment, { key: 1 }, [createTextVNode(toDisplayString(FAILED))], 64)) : unref(journeyPhase) === "empty" ? (openBlock(), createElementBlock("div", _hoisted_1$9, toDisplayString(EMPTY$1))) : (openBlock(true), createElementBlock(Fragment, { key: 3 }, renderList(days.value, (d) => {
				return openBlock(), createElementBlock(Fragment, { key: d.key }, [createElementVNode("div", {
					class: "journey-day",
					hidden: d.rows.every((r) => !visible(r.ev))
				}, toDisplayString(d.label), 9, _hoisted_2$6), (openBlock(true), createElementBlock(Fragment, null, renderList(d.rows, (r) => {
					return openBlock(), createElementBlock("div", mergeProps({
						key: r.key,
						class: r.linked ? "journey-row journey-linked" : "journey-row",
						"data-kind": r.ev.kind,
						"data-agent": r.ev.agentGroupId || "",
						"data-skill": r.ev.skillName || "",
						hidden: !visible(r.ev),
						title: r.ev.description || void 0
					}, { ref_for: true }, r.linked ? {
						role: "button",
						tabindex: "0"
					} : {}, {
						onClick: ($event) => r.linked ? props.onOpen(r.ev) : void 0,
						onKeydown: ($event) => r.linked ? onKey($event, r.ev) : void 0
					}), [
						createElementVNode("span", { class: normalizeClass(`journey-verb journey-verb-${r.ev.kind}`) }, toDisplayString(r.verb), 3),
						createElementVNode("span", _hoisted_4$3, toDisplayString(r.ev.skillName), 1),
						createElementVNode("span", _hoisted_5$2, toDisplayString(r.ev.agentName), 1),
						createElementVNode("span", _hoisted_6$2, toDisplayString(r.meta), 1),
						createElementVNode("span", _hoisted_7$2, toDisplayString(r.time), 1),
						r.ev.canRevert ? (openBlock(), createElementBlock("button", {
							key: 0,
							type: "button",
							class: "btn btn-secondary",
							onClick: withModifiers(($event) => props.onRevert(r.ev), ["stop"])
						}, toDisplayString(REVERT), 8, _hoisted_8$1)) : createCommentVNode("", true)
					], 16, _hoisted_3$6);
				}), 128))], 64);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/views.ts
var deps$7 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideViewsDeps(provided) {
	Object.assign(deps$7, provided);
}
function openView(name, teardown) {
	viewStack.push({
		name,
		teardown
	});
	history.pushState({ viewDepth: viewStack.length }, "");
}
function closeView(name) {
	const idx = viewStack.map((v) => v.name).lastIndexOf(name);
	if (idx === -1) return;
	history.go(-(viewStack.length - idx));
}
function openFullView(fn) {
	if (deps$7.getDetailRouterOpen()) {
		deps$7.setAfterDetailClose(fn);
		deps$7.closeAllDetailDrawers();
		return;
	}
	fn();
}
function openManage(tab = "agents") {
	openFullView(() => {
		hideOtherFullViews("manage");
		$("#chat").hidden = false;
		$("#app").classList.remove("in-dashboard");
		manageActive.value = true;
		$("#manage").hidden = false;
		$("#overflow-btn")?.classList.add("active");
		switchManageTab(tab);
		if (!viewStack.some((v) => v.name === "manage")) openView("manage", teardownManage);
		deps$7.probeRoutingAvailability();
	});
}
function teardownManage() {
	manageActive.value = false;
	$("#manage").hidden = true;
	$("#overflow-btn")?.classList.remove("active");
}
function switchManageTab(tab) {
	manageTab.value = tab;
	document.querySelectorAll(".manage-tab").forEach((t) => {
		const on = t.dataset.mtab === tab;
		t.classList.toggle("active", on);
		t.setAttribute("aria-selected", String(on));
	});
	$("#mtab-agents").hidden = tab !== "agents";
	$("#mtab-models").hidden = tab !== "models";
	$("#mtab-mcp").hidden = tab !== "mcp";
	$("#mtab-skills").hidden = tab !== "skills";
	$("#mtab-routing").hidden = tab !== "routing";
	if (typeof syncManageSortIcon === "function") syncManageSortIcon();
	const agentFilterEl = $("#agent-filter");
	if (agentFilterEl) {
		agentFilterEl.hidden = tab !== "agents";
		if (tab !== "agents" && agentFilter.value) {
			agentFilterEl.value = "";
			agentFilter.value = "";
		}
	}
	if (tab === "agents") fetchAgents();
	else if (tab === "models") fetchModels();
	else if (tab === "mcp") {
		fetchMcpServers();
		renderMcpSources();
	} else if (tab === "skills") {
		renderSkillsRegistry();
		renderSkillSources();
	} else if (tab === "routing") {
		if (!routingAvailable.value && !state.isOwnerView) return switchManageTab("agents");
		renderRoutingSetup();
		if (routingAvailable.value) deps$7.loadRoutingTab();
	}
}
var dashboardActive = false;
function hideOtherFullViews(keep) {
	if (keep !== "manage" && manageActive.value) {
		manageActive.value = false;
		$("#manage").hidden = true;
		$("#overflow-btn")?.classList.remove("active");
	}
	if (keep !== "dashboard" && dashboardActive) {
		dashboardActive = false;
		$("#dashboard").hidden = true;
		$("#dash-btn")?.classList.remove("active");
	}
	if (keep !== "admin" && adminActive.value) {
		adminActive.value = false;
		$("#admin").hidden = true;
		$("#overflow-btn")?.classList.remove("active");
	}
	if (keep !== "permissions" && permsActive.value) {
		permsActive.value = false;
		$("#permissions").hidden = true;
	}
	if (keep !== "topology" && topologyActive) {
		topologyActive = false;
		$("#topology").hidden = true;
	}
	if (keep !== "journey" && journeyActive) {
		journeyActive = false;
		$("#journey").hidden = true;
	}
	if (keep !== "matrix" && matrixActive) {
		matrixActive = false;
		$("#matrix").hidden = true;
	}
	if (keep !== "help" && helpActive.value) {
		helpActive.value = false;
		$("#help").hidden = true;
	}
}
function openDashboard() {
	openFullView(() => {
		hideOtherFullViews("dashboard");
		dashboardActive = true;
		$("#chat").hidden = true;
		$("#dashboard").hidden = false;
		$("#dash-btn")?.classList.add("active");
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshDashboard();
		openView("dashboard", teardownDashboard);
	});
}
function teardownDashboard() {
	dashboardActive = false;
	$("#chat").hidden = false;
	$("#dashboard").hidden = true;
	$("#dash-btn")?.classList.remove("active");
	$("#app").classList.remove("in-dashboard");
}
function toggleDashboard() {
	if (dashboardActive) closeView("dashboard");
	else openDashboard();
}
var topologyActive = false;
function openTopology() {
	openFullView(() => {
		hideOtherFullViews("topology");
		topologyActive = true;
		$("#chat").hidden = true;
		$("#topology").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshTopology();
		openView("topology", teardownTopology);
	});
}
function teardownTopology() {
	topologyActive = false;
	$("#chat").hidden = false;
	$("#topology").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleTopology() {
	if (topologyActive) closeView("topology");
	else openTopology();
}
var journeyActive = false;
var journeyAgents = /* @__PURE__ */ new Map();
function setJourneyPreset(preset) {
	journeyFilter.value.agent = preset?.agentGroupId || "";
	journeyFilter.value.kind = "";
	journeyFilter.value.skill = preset?.skill || "";
	if (journeyFilter.value.agent && !journeyAgents.has(journeyFilter.value.agent)) {
		const known = typeof state.allAgents !== "undefined" && state.allAgents.find?.((a) => a.id === journeyFilter.value.agent);
		journeyAgents.set(journeyFilter.value.agent, preset?.agentName || known && known.name || journeyFilter.value.agent);
	}
	renderJourneyFilterControls();
}
function openJourney(preset) {
	if (journeyActive) {
		setJourneyPreset(preset);
		applyJourneyFilters();
		return;
	}
	openFullView(() => {
		hideOtherFullViews("journey");
		journeyActive = true;
		$("#chat").hidden = true;
		$("#journey").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		journeyAgents.clear();
		setJourneyPreset(preset);
		refreshJourney(true);
		openView("journey", teardownJourney);
	});
}
function teardownJourney() {
	journeyActive = false;
	$("#chat").hidden = false;
	$("#journey").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleJourney() {
	if (journeyActive) closeView("journey");
	else openJourney();
}
var journeyCursor = null;
async function refreshJourney(reset) {
	if (!$("#journey-list")) return;
	if (reset) {
		journeyCursor = null;
		journeyEvents.value = [];
		journeyPhase.value = "loading";
	}
	mountJourney();
	const more = $("#journey-more");
	try {
		const data = await apiJson(`/api/learning/timeline?limit=100${!reset && journeyCursor ? `&before=${journeyCursor}` : ""}`);
		const events = data.events || [];
		noteJourneyAgents(events);
		journeyEvents.value = reset ? events : [...journeyEvents.value, ...events];
		journeyCursor = data.nextBefore || null;
		if (more) more.hidden = !journeyCursor;
		journeyPhase.value = journeyEvents.value.length ? "ready" : "empty";
		renderJourneyFilterControls();
		applyJourneyFilters();
	} catch (err) {
		if (reset) journeyPhase.value = "error";
		else toastError(err, "Could not load more");
	}
}
var JOURNEY_VERBS = {
	proposed: "Proposed",
	kept: "Kept",
	discarded: "Discarded",
	revised: "Revised",
	archived: "Archived"
};
function journeyMeta(ev) {
	const bits = [];
	if (ev.kind === "kept" && ev.by === "auto-keep") bits.push("kept automatically");
	else if (ev.kind === "discarded" && ev.by === "expired") bits.push("expired unreviewed");
	else if (ev.kind === "discarded" && ev.by === "superseded") bits.push("replaced by a newer draft");
	else if (ev.kind === "archived") bits.push("unused, moved to the archive");
	if (ev.roomName) bits.push(ev.roomName);
	return bits.join(" · ");
}
var journeyApp = null;
function mountJourney() {
	if (journeyApp) return;
	const host = $("#journey-list");
	if (!host) return;
	journeyApp = createApp(JourneyList_default, {
		verbs: JOURNEY_VERBS,
		meta: journeyMeta,
		onOpen: (ev) => openScopedSkillEditor(ev.agentGroupId, ev.skillName),
		onRevert: async (ev) => {
			if (!await showConfirmModal({
				title: `Revert ${ev.skillName}?`,
				body: "Restores the previous version. The current version is kept in history.",
				confirmLabel: "Revert",
				destructive: true
			})) return;
			try {
				await apiJson(`/api/agents/${encodeURIComponent(ev.agentGroupId)}/skills/scoped/${encodeURIComponent(ev.skillName)}/revert`, { method: "POST" });
				showToast(`Reverted ${ev.skillName}`, { kind: "success" });
				refreshJourney(true);
			} catch (err) {
				toastError(err, "Revert failed");
			}
		}
	});
	journeyApp.mount(host);
}
/** Record the agents seen in a page, for the filter dropdown. */
function noteJourneyAgents(events) {
	for (const ev of events) if (ev.agentGroupId && !journeyAgents.has(ev.agentGroupId)) journeyAgents.set(ev.agentGroupId, ev.agentName || ev.agentGroupId);
}
function renderJourneyFilterControls() {
	const sel = $("#journey-agent-filter");
	if (sel) {
		sel.innerHTML = "";
		sel.appendChild(new Option("All agents", ""));
		for (const [id, name] of [...journeyAgents].sort((a, b) => a[1].localeCompare(b[1]))) sel.appendChild(new Option(name, id));
		sel.value = journeyFilter.value.agent;
		if (sel.value !== journeyFilter.value.agent) journeyFilter.value.agent = "";
	}
	for (const b of document.querySelectorAll("#journey-kind-filter .setting-option")) {
		const active = (b.dataset.kind || "") === journeyFilter.value.kind;
		b.classList.toggle("active", active);
		b.setAttribute("aria-pressed", String(active));
	}
	const chip = $("#journey-skill-chip");
	if (chip) {
		chip.hidden = !journeyFilter.value.skill;
		if (journeyFilter.value.skill) chip.textContent = `skill: ${journeyFilter.value.skill} ✕`;
	}
}
function applyJourneyFilters() {
	const f = journeyFilter.value;
	journeyFilter.value = {
		agent: f.agent || "",
		kind: f.kind || "",
		skill: f.skill || ""
	};
	const total = journeyEvents.value.length;
	const shown = journeyEvents.value.filter((ev) => (!f.agent || (ev.agentGroupId || "") === f.agent) && (!f.kind || ev.kind === f.kind) && (!f.skill || (ev.skillName || "") === f.skill)).length;
	const none = $("#journey-no-match");
	if (none) none.hidden = !(total > 0 && shown === 0);
}
async function refreshTopology() {
	const canvas = $("#topology-canvas");
	if (!canvas) return;
	canvas.textContent = "Loading…";
	try {
		const r = await authFetch("/api/topology");
		if (!r.ok) {
			canvas.textContent = "Could not load topology.";
			return;
		}
		renderTopology(await r.json());
	} catch {
		canvas.textContent = "Could not load topology.";
	}
}
function renderTopology(data) {
	const canvas = $("#topology-canvas");
	if (!canvas) return;
	topoData.value = data;
	setTopoFocus(null);
	updateTopoFocusPill();
	canvas.textContent = "";
	const rooms = data.rooms || [];
	const agents = data.agents || [];
	const models = data.models || [];
	const edges = data.edges || [];
	const mcpServers = data.mcpServers || [];
	const mcpEdges = data.mcpEdges || [];
	const skills = data.skills || [];
	const skillEdges = data.skillEdges || [];
	if (rooms.length === 0) {
		canvas.textContent = "No rooms yet.";
		return;
	}
	const push = (m, k, v) => {
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(v);
	};
	const agentRooms = /* @__PURE__ */ new Map();
	const roomAgents = /* @__PURE__ */ new Map();
	const modelAgents = /* @__PURE__ */ new Map();
	for (const e of edges) {
		push(agentRooms, e.agent, e.room);
		push(roomAgents, e.room, e.agent);
	}
	for (const a of agents) if (a.modelId) push(modelAgents, a.modelId, a.id);
	const mcpAgents = /* @__PURE__ */ new Map();
	const agentMcps = /* @__PURE__ */ new Map();
	for (const e of mcpEdges) {
		push(mcpAgents, e.mcp, e.agent);
		push(agentMcps, e.agent, e.mcp);
	}
	const skillAgents = /* @__PURE__ */ new Map();
	for (const e of skillEdges) push(skillAgents, e.skill, e.agent);
	const indexMap = (arr) => new Map(arr.map((x, i) => [x.id, i]));
	const bary = (neighbors, posMap) => !neighbors || neighbors.length === 0 ? Number.POSITIVE_INFINITY : neighbors.reduce((s, n) => s + (posMap.get(n) ?? 0), 0) / neighbors.length;
	const reorder = (items, neighborsOf, posMap) => {
		const ranked = items.map((it, i) => ({
			id: it.id,
			b: bary(neighborsOf(it.id), posMap),
			i
		}));
		ranked.sort((x, y) => x.b - y.b || x.i - y.i);
		return new Map(ranked.map((r, i) => [r.id, i]));
	};
	let roomY = indexMap(rooms);
	let agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
	let modelY = reorder(models, (id) => modelAgents.get(id), agentY);
	roomY = reorder(rooms, (id) => roomAgents.get(id), agentY);
	agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
	modelY = reorder(models, (id) => modelAgents.get(id), agentY);
	const mcpY = reorder(mcpServers, (id) => mcpAgents.get(id), agentY);
	const skillY = reorder(skills, (id) => skillAgents.get(id), agentY);
	const ROW = 46;
	const PAD = 28;
	const COLW = 240;
	const cols = {
		room: PAD,
		agent: 268,
		model: 508,
		mcp: 748,
		skill: 988
	};
	const rowsCount = Math.max(rooms.length, agents.length, models.length, mcpServers.length, skills.length, 1);
	const svg = svgEl("svg", {
		viewBox: `0 0 ${(skills.length ? cols.skill : mcpServers.length ? cols.mcp : cols.model) + COLW} ${76 + rowsCount * ROW}`,
		class: "topology-svg",
		preserveAspectRatio: "xMidYMin meet"
	});
	const NODE_X = 6;
	const LABEL_W = 84;
	const yPx = (yMap, id) => 48 + (yMap.get(id) ?? 0) * ROW + ROW / 2;
	const heads = [
		["Rooms", cols.room],
		["Agents", cols.agent],
		["Models", cols.model],
		...mcpServers.length ? [["MCP servers", cols.mcp]] : [],
		...skills.length ? [["Skills", cols.skill]] : []
	];
	for (const [label, x] of heads) {
		const h = svgEl("text", {
			x: String(x),
			y: String(PAD),
			class: "topo-col-head"
		});
		h.textContent = label;
		svg.appendChild(h);
	}
	const edgeLine = (x1, y1, x2, y2, stroke) => {
		const ln = svgEl("line", {
			x1,
			y1,
			x2,
			y2,
			class: "topo-edge"
		});
		if (stroke) ln.style.stroke = stroke;
		return svg.appendChild(ln);
	};
	for (const e of edges) {
		const ln = edgeLine(cols.room + LABEL_W, yPx(roomY, e.room), cols.agent - NODE_X, yPx(agentY, e.agent), roomColor(e.room));
		ln.setAttribute("data-room", e.room);
		ln.setAttribute("data-agent", e.agent);
	}
	for (const a of agents) if (a.modelId) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, a.id), cols.model - NODE_X, yPx(modelY, a.modelId));
		ln.setAttribute("data-agent", a.id);
		ln.setAttribute("data-model", a.modelId);
	}
	for (const e of mcpEdges) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.mcp - NODE_X, yPx(mcpY, e.mcp));
		ln.classList.add("topo-edge-mcp");
		ln.setAttribute("data-agent", e.agent);
		ln.setAttribute("data-mcp", e.mcp);
	}
	for (const e of skillEdges) {
		const ln = edgeLine(cols.agent + LABEL_W, yPx(agentY, e.agent), cols.skill - NODE_X, yPx(skillY, e.skill));
		ln.classList.add("topo-edge-skill");
		ln.setAttribute("data-agent", e.agent);
		ln.setAttribute("data-skill", e.skill);
	}
	const drawNode = (x, yMap, item, kind, degree, stroke) => {
		const y = yPx(yMap, item.id);
		const g = svgEl("g", { class: `topo-node topo-${kind}${degree === 0 ? " topo-orphan" : ""}` });
		g.style.cursor = "pointer";
		g.setAttribute("role", "button");
		g.setAttribute("tabindex", "0");
		g.setAttribute("aria-label", `Open ${kind} settings: ${item.name}`);
		g.setAttribute("data-kind", kind);
		g.setAttribute("data-node-id", item.id);
		const activate = () => {
			setTopoFocus(kind, item.id, item.name);
			openTopologyItem(kind, item.id);
		};
		g.addEventListener("click", activate);
		g.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				activate();
			}
		});
		const c = svgEl("circle", {
			cx: x,
			cy: y,
			r: NODE_X
		});
		if (stroke && degree > 0) c.style.stroke = stroke;
		g.appendChild(c);
		const t = svgEl("text", {
			x: x + 11,
			y: y + 4,
			class: "topo-label"
		});
		t.textContent = degree > 0 ? `${item.name} · ${degree}` : item.name;
		g.appendChild(t);
		svg.appendChild(g);
	};
	for (const r of rooms) drawNode(cols.room, roomY, r, "room", (roomAgents.get(r.id) || []).length, roomColor(r.id));
	for (const a of agents) drawNode(cols.agent, agentY, a, "agent", (agentRooms.get(a.id) || []).length);
	for (const m of models) drawNode(cols.model, modelY, m, "model", (modelAgents.get(m.id) || []).length);
	for (const srv of mcpServers) drawNode(cols.mcp, mcpY, srv, "mcp", (mcpAgents.get(srv.id) || []).length);
	for (const sk of skills) drawNode(cols.skill, skillY, sk, "skill", (skillAgents.get(sk.id) || []).length);
	svg.addEventListener("click", (ev) => {
		if (ev.target === svg) clearTopoFocus();
	});
	canvas.appendChild(svg);
}
async function openTopologyItem(kind, id) {
	try {
		if (kind === "room") await openRoomDetail(id);
		else if (kind === "agent") {
			if (!state.allAgents.length) await fetchAgents();
			await openAgentDetail(id);
		} else if (kind === "model") {
			if (!allModels.value.length) await fetchModels();
			await openModelDetail(id);
		} else if (kind === "mcp") await openMcpDetail(id);
	} catch (err) {
		showToast("Couldn’t open settings: " + (err?.message || err), { kind: "error" });
	}
}
var matrixActive = false;
function openMatrix() {
	openFullView(() => {
		hideOtherFullViews("matrix");
		matrixActive = true;
		$("#chat").hidden = true;
		$("#matrix").hidden = false;
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		refreshMatrix();
		openView("matrix", teardownMatrix);
	});
}
function teardownMatrix() {
	matrixActive = false;
	$("#chat").hidden = false;
	$("#matrix").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleMatrix() {
	if (matrixActive) closeView("matrix");
	else openMatrix();
}
async function refreshMatrix() {
	const canvas = $("#matrix-canvas");
	if (!canvas) return;
	canvas.textContent = "Loading…";
	try {
		const r = await authFetch("/api/topology");
		if (!r.ok) {
			canvas.textContent = "Could not load wiring.";
			return;
		}
		renderMatrix(await r.json());
	} catch {
		canvas.textContent = "Could not load wiring.";
	}
}
var matrixApp$1 = null;
function mountMatrix() {
	if (matrixApp$1) return;
	const host = $("#matrix-canvas");
	if (!host) return;
	matrixApp$1 = createApp(WiringMatrix_default);
	matrixApp$1.mount(host);
}
function renderMatrix(data) {
	if (!$("#matrix-canvas")) return;
	const rooms = data.rooms || [];
	const agents = data.agents || [];
	matrixWired.value = new Set((data.edges || []).map((e) => `${e.room}|${e.agent}`));
	matrixRooms.value = rooms;
	matrixAgents.value = agents;
	matrixEdges.value = new Set(matrixWired.value);
	mountMatrix();
}
/** Re-read the edge set after legacy toggles a cell. */
function refreshMatrixCells() {
	matrixEdges.value = new Set(matrixWired.value);
}
var usageRangeDays = 7;
var usageWired = false;
var usageApps = [];
function mountUsage() {
	if (usageApps.length) return;
	const mounts = [
		["#usage-tbody", UsageTable_default],
		["#usage-spark", UsageSpark_default],
		["#usage-models", UsageModels_default]
	];
	for (const [sel, comp] of mounts) {
		const host = $(sel);
		if (!host) continue;
		const app = createApp(comp);
		app.mount(host);
		usageApps.push(app);
	}
}
/**
* Token usage — a DASHBOARD panel now, not a Settings section. Usage is a
* thing you check, not a thing you configure; it sat in Settings because
* that was the only owner-gated surface at the time. The endpoint stays
* owner-only and a 403 hides the whole panel, so the move changes surface,
* not audience.
*/
async function renderUsagePanel() {
	const section = $("#dash-usage-section");
	if (!section) return;
	let data = null;
	try {
		const r = await authFetch("/api/webchat/usage?days=" + usageRangeDays);
		if (!r.ok) {
			section.hidden = true;
			return;
		}
		data = await r.json();
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	if (!usageWired) {
		usageWired = true;
		document.querySelectorAll("#usage-range .setting-option").forEach((b) => {
			b.addEventListener("click", () => {
				usageRangeDays = Number(b.dataset.days) || 7;
				document.querySelectorAll("#usage-range .setting-option").forEach((x) => x.classList.toggle("active", x === b));
				renderUsagePanel();
			});
		});
	}
	const fmt = (n) => n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
	$("#usage-total").textContent = "~" + fmt(data.totals.tokens) + " tokens · " + data.totals.turns + " turns · " + data.totals.users + " user" + (data.totals.users === 1 ? "" : "s");
	mountUsage();
	const table = $("#usage-table");
	const empty = $("#usage-empty");
	usageRows.value = data.perUser.map((u) => ({ cells: [
		String(u.user).split(":").pop(),
		"~" + fmt(u.inputTokens),
		"~" + fmt(u.outputTokens),
		"~" + fmt(u.totalTokens),
		String(u.turns)
	] }));
	table.hidden = !data.perUser.length;
	empty.hidden = !!data.perUser.length;
	const spark = $("#usage-spark");
	if (data.perDay.length > 1) {
		const max = Math.max.apply(null, data.perDay.map((d) => d.tokens).concat(1));
		usageBars.value = data.perDay.map((d) => ({
			height: Math.max(4, Math.round(d.tokens / max * 36)) + "px",
			title: d.day + ": ~" + fmt(d.tokens)
		}));
		spark.hidden = false;
	} else {
		usageBars.value = [];
		spark.hidden = true;
	}
	const models = $("#usage-models");
	usageModels.value = data.byModel.map((m) => m.model + " · ~" + fmt(m.tokens));
	models.hidden = !data.byModel.length;
}
async function refreshDashboard() {
	renderUsagePanel();
	let snap;
	try {
		const res = await authFetch("/api/overview");
		if (!res.ok) {
			$("#dash-graph").innerHTML = `<div class="dash-empty">Unable to load overview (${res.status})</div>`;
			return;
		}
		snap = await res.json();
	} catch (err) {
		$("#dash-graph").innerHTML = `<div class="dash-empty">Unable to load overview: ${esc(err?.message)}</div>`;
		return;
	}
	renderHealthStrip(snap);
	renderMetrics(snap);
	deps$7.refreshRouterMetrics();
}
function syncManageSortIcon() {
	const btn = $("#manage-sort-az");
	if (!btn) return;
	const on = manageTab.value === "models" ? modelSortAz.value : agentSortAz.value;
	btn.classList.toggle("active", on);
	btn.setAttribute("aria-pressed", on ? "true" : "false");
}
function wireViewsPanel() {
	$("#journey-more")?.addEventListener("click", () => void refreshJourney(false));
	$("#journey-agent-filter")?.addEventListener("change", (e) => {
		journeyFilter.value.agent = e.target.value;
		applyJourneyFilters();
	});
	$("#journey-kind-filter")?.addEventListener("click", (e) => {
		const btn = e.target?.closest(".setting-option");
		if (!btn) return;
		journeyFilter.value.kind = btn.dataset.kind || "";
		renderJourneyFilterControls();
		applyJourneyFilters();
	});
	$("#journey-skill-chip")?.addEventListener("click", () => {
		journeyFilter.value.skill = "";
		renderJourneyFilterControls();
		applyJourneyFilters();
	});
	$("#matrix-canvas")?.addEventListener("click", async (e) => {
		const cell = e.target?.closest(".matrix-cell");
		if (!cell || cell.classList.contains("pending")) return;
		const roomId = cell.dataset.room;
		const agentId = cell.dataset.agent;
		if (!roomId || !agentId) return;
		const wantWired = !cell.classList.contains("on");
		cell.classList.add("pending");
		cell.classList.toggle("on", wantWired);
		try {
			const r = wantWired ? await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "existing",
					id: agentId
				})
			}) : await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
			matrixWired.value[wantWired ? "add" : "delete"](`${roomId}|${agentId}`);
			refreshMatrixCells();
		} catch (err) {
			cell.classList.toggle("on", !wantWired);
			showToast("Could not update wiring: " + (err.message || err), { kind: "error" });
		} finally {
			cell.classList.remove("pending");
		}
	});
}
function wireViewChrome1() {
	$("#dash-btn")?.addEventListener("click", toggleDashboard);
	$("#dash-back")?.addEventListener("click", toggleDashboard);
	$("#dash-refresh")?.addEventListener("click", refreshDashboard);
	$("#topology-back")?.addEventListener("click", toggleTopology);
	$("#topology-refresh")?.addEventListener("click", refreshTopology);
}
function wireViewChrome2() {
	$("#agent-filter")?.addEventListener("input", (e) => {
		agentFilter.value = e.target.value;
	});
	$("#manage-sort-az")?.addEventListener("click", () => {
		if (manageTab.value === "models") {
			modelSortAz.value = !modelSortAz.value;
			sessionStorage.setItem("webchat:modelSortAz", modelSortAz.value ? "1" : "0");
			renderModels();
		} else {
			agentSortAz.value = !agentSortAz.value;
			sessionStorage.setItem("webchat:agentSortAz", agentSortAz.value ? "1" : "0");
			renderAgents();
		}
		syncManageSortIcon();
	});
}
var SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const k in attrs) el.setAttribute(k, String(attrs[k]));
	return el;
}
var topoFocus = null;
function updateTopoFocusPill() {
	const pill = $("#topo-focus-pill");
	if (!pill) return;
	if (topoFocus) {
		pill.textContent = `Focused: ${topoFocus.name} ✕`;
		pill.hidden = false;
	} else pill.hidden = true;
}
function applyTopoFocus() {
	const svg = $("#topology-canvas")?.querySelector("svg");
	if (!svg) return;
	if (!topoFocus) {
		svg.querySelectorAll(".topo-dimmed").forEach((el) => el.classList.remove("topo-dimmed"));
		return;
	}
	const hl = computeTopoFocus(topoData.value, topoFocus.kind, topoFocus.id);
	const setFor = (k) => k === "room" ? hl.rooms : k === "agent" ? hl.agents : k === "mcp" ? hl.mcps : k === "skill" ? hl.skills : hl.models;
	svg.querySelectorAll(".topo-node").forEach((g) => {
		const on = setFor(g.getAttribute("data-kind")).has(g.getAttribute("data-node-id") ?? "");
		g.classList.toggle("topo-dimmed", !on);
	});
	svg.querySelectorAll(".topo-edge").forEach((ln) => {
		const on = ln.hasAttribute("data-skill") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.skills.has(ln.getAttribute("data-skill")) : ln.hasAttribute("data-mcp") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.mcps.has(ln.getAttribute("data-mcp")) : ln.hasAttribute("data-model") ? hl.agents.has(ln.getAttribute("data-agent")) && hl.models.has(ln.getAttribute("data-model")) : hl.rooms.has(ln.getAttribute("data-room")) && hl.agents.has(ln.getAttribute("data-agent"));
		ln.classList.toggle("topo-dimmed", !on);
	});
}
function setTopoFocus(kind, id, name) {
	topoFocus = {
		kind,
		id,
		name
	};
	applyTopoFocus();
	updateTopoFocusPill();
}
function clearTopoFocus() {
	topoFocus = null;
	applyTopoFocus();
	updateTopoFocusPill();
}
function formatUptime(seconds) {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor(seconds % 86400 / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}
function renderHealthStrip(snap) {
	const wsOk = state.ws && state.ws.readyState === WebSocket.OPEN;
	const pills = [
		{
			dot: "ok",
			label: "Server",
			value: "Online"
		},
		{
			dot: "ok",
			label: "Uptime",
			value: snap.health.uptime ? formatUptime(snap.health.uptime) : "—"
		},
		{
			dot: wsOk ? "ok" : "err",
			label: "WebSocket",
			value: wsOk ? "Connected" : "Disconnected"
		}
	];
	if (snap.health.container_runtime_ok !== void 0 && !snap.restricted) pills.push({
		dot: snap.health.container_runtime_ok ? "ok" : "warn",
		label: "Containers",
		value: snap.health.container_runtime_ok ? "Up" : "Unreachable"
	});
	$("#dash-health").innerHTML = pills.map((p) => `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${esc(p.label)}</span><span class="pill-value">${esc(p.value)}</span></div>`).join("");
}
function computeTopoFocus(data, kind, id) {
	const agents = data?.agents || [];
	const edges = data?.edges || [];
	const mcpEdges = data?.mcpEdges || [];
	const skillEdges = data?.skillEdges || [];
	const rooms = /* @__PURE__ */ new Set();
	const ags = /* @__PURE__ */ new Set();
	const models = /* @__PURE__ */ new Set();
	const mcps = /* @__PURE__ */ new Set();
	const skls = /* @__PURE__ */ new Set();
	const agentModel = new Map(agents.map((a) => [a.id, a.modelId]));
	const roomsOfAgent = /* @__PURE__ */ new Map();
	const agentsOfRoom = /* @__PURE__ */ new Map();
	const agentsOfModel = /* @__PURE__ */ new Map();
	const agentsOfMcp = /* @__PURE__ */ new Map();
	const mcpsOfAgent = /* @__PURE__ */ new Map();
	const agentsOfSkill = /* @__PURE__ */ new Map();
	const skillsOfAgent = /* @__PURE__ */ new Map();
	const push = (m, k, v) => {
		if (k == null) return;
		if (!m.has(k)) m.set(k, []);
		m.get(k).push(v);
	};
	for (const e of edges) {
		push(roomsOfAgent, e.agent, e.room);
		push(agentsOfRoom, e.room, e.agent);
	}
	for (const a of agents) if (a.modelId) push(agentsOfModel, a.modelId, a.id);
	for (const e of mcpEdges) {
		push(agentsOfMcp, e.mcp, e.agent);
		push(mcpsOfAgent, e.agent, e.mcp);
	}
	for (const e of skillEdges) {
		push(agentsOfSkill, e.skill, e.agent);
		push(skillsOfAgent, e.agent, e.skill);
	}
	if (kind === "model") {
		models.add(id);
		for (const a of agentsOfModel.get(id) || []) {
			ags.add(a);
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	} else if (kind === "agent") {
		ags.add(id);
		if (agentModel.get(id)) models.add(agentModel.get(id));
		for (const r of roomsOfAgent.get(id) || []) rooms.add(r);
	} else if (kind === "room") {
		rooms.add(id);
		for (const a of agentsOfRoom.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
		}
	} else if (kind === "mcp") {
		mcps.add(id);
		for (const a of agentsOfMcp.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	} else if (kind === "skill") {
		skls.add(id);
		for (const a of agentsOfSkill.get(id) || []) {
			ags.add(a);
			if (agentModel.get(a)) models.add(agentModel.get(a));
			for (const r of roomsOfAgent.get(a) || []) rooms.add(r);
		}
	}
	for (const a of ags) {
		for (const m of mcpsOfAgent.get(a) || []) mcps.add(m);
		for (const k of skillsOfAgent.get(a) || []) skls.add(k);
	}
	return {
		rooms,
		agents: ags,
		models,
		mcps,
		skills: skls
	};
}
function renderMetrics(snap) {
	const el = $("#dash-graph");
	const num = (v) => esc(String(Number(v) || 0));
	const agentsLabel = snap.restricted ? "Visible agents" : "Agents";
	const agentsCard = `<div class="metric-card clickable" data-detail="agents">
    <div class="metric-value">${num(snap.restricted ? snap.agents.visible : snap.agents.total)}</div>
    <div class="metric-label">${esc(agentsLabel)}</div>
  </div>`;
	const sessionsCard = `<div class="metric-card">
    <div class="metric-value">${num(snap.sessions.active)}</div>
    <div class="metric-label">Active sessions</div>
    <div class="metric-sub">${num(snap.sessions.total)} total</div>
  </div>`;
	const messagesCard = `<div class="metric-card clickable" data-detail="messages">
    <div class="metric-value">${num(snap.messages.webchat_24h)}</div>
    <div class="metric-label">Webchat messages (24h)</div>
  </div>`;
	let containersCard;
	if (snap.restricted || snap.active_containers === null) containersCard = `<div class="metric-card">
      <div class="metric-value">—</div>
      <div class="metric-label">Containers</div>
    </div>`;
	else containersCard = `<div class="metric-card clickable" data-detail="containers">
      <div class="metric-value">${num(snap.active_containers)}</div>
      <div class="metric-label">Active containers</div>
    </div>`;
	const topRow = `<div class="metrics-grid">${agentsCard}${sessionsCard}${messagesCard}${containersCard}</div>`;
	let systemCards = "";
	if (snap.system) {
		const memBar = snap.system.memory_used_pct;
		const memColor = memBar > 85 ? "var(--delete-color)" : memBar > 60 ? "#ffd54f" : "var(--accent)";
		const loadStr = snap.system.load_avg.join(" / ");
		const sysCard = `<div class="metric-card wide">
      <div class="metric-label">System</div>
      <div class="sys-row"><span>Memory</span><span>${num(snap.system.memory_used_gb)} / ${num(snap.system.memory_total_gb)} GB (${num(memBar)}%)</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${num(memBar)}%;background:${memColor}"></div></div>
      <div class="sys-row"><span>CPU Load (1/5/15m)</span><span>${esc(loadStr)}</span></div>
      <div class="sys-row"><span>CPUs</span><span>${num(snap.system.cpus)}</span></div>
      <div class="sys-row"><span>Platform</span><span>${esc(snap.system.platform)}</span></div>
    </div>`;
		let ollamaCard;
		if (!snap.ollama) ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">Ollama</div>
        <div class="metric-sub">Not configured</div>
      </div>`;
		else {
			const dot = snap.ollama.ok ? "<span class=\"pill-dot ok\"></span>" : "<span class=\"pill-dot err\"></span>";
			const models = snap.ollama.models && snap.ollama.models.length ? snap.ollama.models.map((m) => `<span class="model-tag">${esc(m)}</span>`).join(" ") : "<span class=\"metric-sub\">No models</span>";
			ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">${dot} Ollama</div>
        <div class="sys-row"><span>Host</span><span>${esc(snap.ollama.host)}</span></div>
        <div class="sys-row"><span>Status</span><span>${snap.ollama.ok ? "Connected" : "Unreachable"}</span></div>
        <div style="margin-top:6px">${models}</div>
      </div>`;
		}
		systemCards = `<div class="metrics-grid two-col">${sysCard}${ollamaCard}</div>`;
	}
	let channelsCard = "";
	if (snap.channels) {
		const channelEntries = Object.entries(snap.channels).sort((a, b) => b[1] - a[1]);
		channelsCard = `<div class="metric-card">
      <div class="metric-label">Channels</div>
      ${channelEntries.length === 0 ? "<div class=\"metric-sub\">No channels wired</div>" : channelEntries.map(([ch, count]) => `<div class="channel-row"><span class="channel-name">${esc(ch)}</span><span class="channel-count">${count}</span></div>`).join("")}
    </div>`;
	}
	let busiestCard;
	if (snap.busiest_rooms !== null) busiestCard = `<div class="metric-card">
      <div class="metric-label">Busiest rooms (24h)</div>
      ${snap.busiest_rooms.length === 0 ? "<div class=\"metric-sub\">No activity</div>" : snap.busiest_rooms.map((r) => `<div class="channel-row"><span class="channel-name">#${esc(r.id)}</span><span class="channel-count">${r.count} msgs</span></div>`).join("")}
    </div>`;
	else busiestCard = "";
	const breakdownRow = channelsCard || busiestCard ? `<div class="metrics-grid two-col">${channelsCard}${busiestCard}</div>` : "";
	el.innerHTML = topRow + systemCards + breakdownRow;
	const details = {
		agents: showAgentsDetail,
		messages: showMessagesDetail,
		containers: showContainersDetail
	};
	el.querySelectorAll("[data-detail]").forEach((card) => {
		card.addEventListener("click", details[card.dataset.detail ?? ""]);
	});
}
function hideDetail() {
	$("#dash-detail").hidden = true;
}
async function showMessagesDetail() {
	const rooms = await authFetch("/api/rooms").then((r) => r.json()).catch(() => []);
	const since = Date.now() - 864e5;
	const all = (await Promise.all(rooms.map((room) => authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`).then((r) => r.json()).then((msgs) => msgs.filter((m) => m.created_at > since).map((m) => ({
		...m,
		roomId: room.id
	}))).catch(() => [])))).flat().sort((a, b) => b.created_at - a.created_at).slice(0, 50);
	if (all.length === 0) {
		showDetail("Messages (24h)", "<div class=\"metric-sub\">No messages in the last 24 hours</div>");
		return;
	}
	showDetail("Messages (24h)", `<table class="detail-table">
      <thead><tr><th>Time</th><th>Room</th><th>Sender</th><th>Message</th></tr></thead>
      <tbody>${all.map((m) => {
		const time = new Date(m.created_at).toLocaleTimeString();
		const icon = m.sender_type === "agent" ? lucide("bot") : lucide("user");
		return `<tr>
      <td>${esc(time)}</td>
      <td style="color:${roomColor(m.roomId)}">#${esc(m.roomId)}</td>
      <td>${icon} ${esc(m.sender)}</td>
      <td class="msg-content">${esc(String(m.content || "").slice(0, 100))}</td>
    </tr>`;
	}).join("")}</tbody>
    </table>`);
}
async function showContainersDetail() {
	showDetail("Active containers", `<div class="metric-sub">Run <code>docker ps --filter name=nanoclaw-</code> on the host to see container details. The number on the card reflects what was running at the moment of the last refresh.</div>`);
}
function closeOverflowMenu() {
	const menu = $("#overflow-menu");
	if (!menu) return;
	menu.hidden = true;
	$("#overflow-btn")?.setAttribute("aria-expanded", "false");
}
function closeTopDetailAside() {
	const layers = [
		["members-panel", () => {
			$("#members-panel").hidden = true;
		}],
		["route-detail", closeRouteDetail],
		["model-detail", closeModelDetail],
		["agent-detail", closeAgentDetail],
		["mcp-detail", closeMcpDetail]
	];
	for (const [id, close] of layers) {
		const el = document.getElementById(id);
		if (el && !el.hidden) {
			close();
			return true;
		}
	}
	return false;
}
function openHelp() {
	closeAgentDetail();
	closeRoomDetail();
	closeModelDetail();
	closeMcpDetail();
	hideOtherFullViews("help");
	helpActive.value = true;
	$("#chat").hidden = true;
	$("#help").hidden = false;
	$("#app").classList.add("in-dashboard");
	$("#app").classList.remove("in-room");
	openView("help", teardownHelp);
}
function teardownHelp() {
	helpActive.value = false;
	$("#chat").hidden = false;
	$("#help").hidden = true;
	$("#app").classList.remove("in-dashboard");
}
function toggleHelp() {
	if (helpActive.value) closeView("help");
	else openHelp();
}
//#endregion
//#region src/features/SelectToggle.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$8 = [
	"title",
	"aria-label",
	"disabled"
];
//#endregion
//#region src/features/SelectToggle.vue
var SelectToggle_default = /* @__PURE__ */ defineComponent({
	__name: "SelectToggle",
	props: {
		kind: {},
		endpoint: {},
		modelId: {},
		displayName: {}
	},
	setup(__props) {
		/**
		* The +/− selectable-model control, declaratively.
		*
		* Not an island — it has no mount point of its own. It is the component half of
		* select-toggle.ts, used by islands that render server rows, while the still
		* imperative call sites keep using buildSelectToggle().
		*
		* It decides nothing. Both what it shows and what the click does come from the
		* module, so this and the imperative builder cannot drift — which matters here
		* because the click DELETES a registration when one already exists.
		*
		* `busy` is local rather than a shared ref: it disables THIS button while its
		* own request is in flight, exactly as `btn.disabled` did. Two rows can be
		* mid-request independently.
		*/
		const props = __props;
		const busy = ref(false);
		const p = computed(() => selectToggleProps(props.kind, props.endpoint, props.modelId));
		function onClick() {
			toggleSelectable(props.kind, props.endpoint, props.modelId, props.displayName, (b) => {
				busy.value = b;
			});
		}
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock("button", {
				type: "button",
				class: normalizeClass(p.value.className),
				title: p.value.title,
				"aria-label": p.value.title,
				disabled: busy.value || void 0,
				onClick
			}, toDisplayString(p.value.label), 11, _hoisted_1$8);
		};
	}
});
//#endregion
//#region src/features/router-roster-state.ts
/** The router's endpoint — the toggle registers against it. */
var rosterEndpoint = ref("");
/** Assignable models, classifier excluded. */
var rosterSelectable = ref([]);
/**
* The classifier, if the router reports one. Served by the router but
* infrastructure — "never a route target" — so it is listed under a separate,
* non-selectable System group rather than with a +/- toggle among the
* assignable models.
*/
var rosterSystem = ref([]);
/** true when the router did not answer, or answered with no models at all. */
var rosterUnreachable = ref(true);
//#endregion
//#region src/features/RouterRoster.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$7 = {
	key: 0,
	class: "ollama-muted"
};
var _hoisted_2$5 = { class: "ollama-model-name" };
var _hoisted_3$5 = { class: "ollama-model-name" };
var UNREACHABLE = "Router not reachable right now…";
var SYS_HEADING$1 = "System — not selectable";
var CLASSIFIER$1 = "classifier";
var CLASSIFIER_TITLE$1 = "Auto-routing classifier — infrastructure, not a selectable or route-target model";
//#endregion
//#region src/features/RouterRoster.vue
var RouterRoster_default = /* @__PURE__ */ defineComponent({
	__name: "RouterRoster",
	setup(__props) {
		/**
		* The router's model roster — twenty-fourth island.
		*
		* Mounted into <ul id="router-roster-list">, exclusively owned by this module.
		*
		* Unblocked by the select-toggle extraction: this list could not become an
		* island while its +/- control arrived as a DOM node from legacy.
		*
		* The empty state covers two different situations the original also merged —
		* the router not answering at all, and answering with an empty model list. The
		* wording ("not reachable right now") is kept as-is; splitting them would be a
		* copy change, not a conversion.
		*/
		return (_ctx, _cache) => {
			return unref(rosterUnreachable) ? (openBlock(), createElementBlock("li", _hoisted_1$7, toDisplayString(UNREACHABLE))) : (openBlock(), createElementBlock(Fragment, { key: 1 }, [(openBlock(true), createElementBlock(Fragment, null, renderList(unref(rosterSelectable), (id) => {
				return openBlock(), createElementBlock("li", { key: id }, [createElementVNode("span", _hoisted_2$5, toDisplayString(id), 1), createVNode(SelectToggle_default, {
					kind: "openai-compatible",
					endpoint: unref(rosterEndpoint),
					"model-id": id,
					"display-name": id
				}, null, 8, [
					"endpoint",
					"model-id",
					"display-name"
				])]);
			}), 128)), unref(rosterSystem).length ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("li", { class: "ollama-model-sysheading" }, toDisplayString(SYS_HEADING$1)), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(rosterSystem), (id) => {
				return openBlock(), createElementBlock("li", { key: id }, [createElementVNode("span", _hoisted_3$5, toDisplayString(id), 1), createElementVNode("span", {
					class: "ollama-model-systag",
					title: CLASSIFIER_TITLE$1
				}, toDisplayString(CLASSIFIER$1))]);
			}), 128))], 64)) : createCommentVNode("", true)], 64));
		};
	}
});
//#endregion
//#region src/features/routing.ts
var deps$6 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideRoutingDeps(provided) {
	Object.assign(deps$6, provided);
}
async function refreshRouterMetrics() {
	const section = $("#dash-router-section");
	if (!section) return;
	try {
		const res = await authFetch("/api/router/metrics?days=7");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		const m = await res.json();
		if (!m.available || m.total === 0) {
			section.hidden = true;
			return;
		}
		section.hidden = false;
		const max = Math.max(...m.byModel.map((x) => x.count), 1);
		const bars = m.byModel.map((x) => `
      <div class="router-bar-row" title="${esc(x.model)}">
        <span class="router-bar-label">${esc(x.model)}</span>
        <span class="router-bar-track"><span class="router-bar-fill" style="width:${Math.max(3, Math.round(100 * x.count / max))}%"></span></span>
        <span class="router-bar-count">${x.count}</span>
      </div>`).join("");
		const routes = m.byRoute.filter((r) => r.route !== "__error__").map((r) => `${esc(r.route)} ${r.count}`).join(" · ");
		const health = [];
		health.push(`${m.total} request${m.total === 1 ? "" : "s"}`);
		health.push(`${m.live} via auto`);
		if (m.escalations > 0) health.push(`${m.escalations} escalated to Claude`);
		if (m.errors > 0) health.push(`${m.errors} classifier error${m.errors === 1 ? "" : "s"}`);
		$("#dash-router").innerHTML = `<div class="router-summary">${esc(health.join(" · "))}</div>` + bars + (routes ? `<div class="router-routes">Routes: ${routes}</div>` : "");
	} catch {
		section.hidden = true;
	}
}
async function probeRoutingAvailability() {
	try {
		const res = await authFetch("/api/router/routes");
		const data = await res.json().catch(() => ({}));
		routingAvailable.value = res.ok && data.installed !== false;
		routingClassifierModel.value = data.classifier || null;
	} catch {
		routingAvailable.value = false;
	}
	const reveal = routingAvailable.value || state.isOwnerView;
	document.querySelectorAll(".manage-tab[data-mtab=\"routing\"], .overflow-item[data-action=\"routing\"]").forEach((el) => {
		el.hidden = !reveal;
	});
	if (!reveal && manageTab.value === "routing") switchManageTab("agents");
}
async function loadRoutingTab() {
	try {
		const q = routingCurrentRouter.value ? `?router=${encodeURIComponent(routingCurrentRouter.value)}` : "";
		const [routesRes, rosterRes] = await Promise.all([authFetch("/api/router/routes" + q), authFetch("/api/router/models")]);
		if (!routesRes.ok) throw new Error((await routesRes.json()).error || routesRes.status);
		routingDraft.value = await routesRes.json();
		routingCurrentRouter.value = routingDraft.value.router ?? null;
		routingRouterInfo.value = rosterRes.ok ? await rosterRes.json() : null;
	} catch (err) {
		showToast("Auto routing config unavailable: " + err?.message, { kind: "error" });
		return;
	}
	if (allModels.value.length === 0) await fetchModels();
	renderRouterPicker();
	renderRouteList();
	renderRouterRoster();
	renderRouteSuggestions();
	if (routingSubtab === "logs") refreshRoutingDecisions();
	$("#routing-bench-result").hidden = true;
	$("#routing-bench-result-log").hidden = true;
}
function renderRouterPicker() {
	const sel = $("#router-select");
	const names = routingDraft.value?.routers ?? [routingCurrentRouter.value ?? "auto"];
	const picker = $("#router-picker");
	picker.hidden = names.length <= 1;
	sel.innerHTML = "";
	for (const n of names) {
		const o = document.createElement("option");
		o.value = n;
		o.textContent = n;
		if (n === routingCurrentRouter.value) o.selected = true;
		sel.appendChild(o);
	}
	$("#router-delete-btn").disabled = names.length <= 1;
	updateRoutingIntro();
}
async function updateRoutingIntro() {
	const intro = $("#routing-intro");
	if (intro) intro.hidden = true;
}
var routingSubtab = "rules";
function switchRoutingSubtab(which) {
	routingSubtab = which;
	document.querySelectorAll(".routing-subtab").forEach((b) => {
		const on = b.dataset.rsub === which;
		b.classList.toggle("active", on);
		b.setAttribute("aria-selected", on ? "true" : "false");
	});
	$("#rsub-rules").hidden = which !== "rules";
	$("#rsub-models").hidden = which !== "models";
	$("#rsub-logs").hidden = which !== "logs";
	if (which === "logs") refreshRoutingDecisions();
}
var rosterApp = null;
function mountRouterRoster() {
	if (rosterApp) return;
	const host = $("#router-roster-list");
	if (!host) return;
	rosterApp = createApp(RouterRoster_default);
	rosterApp.mount(host);
}
function renderRouterRoster() {
	if (!$("#router-roster-list")) return;
	mountRouterRoster();
	const info = routingRouterInfo.value;
	if (!info || info.models.length === 0) {
		rosterUnreachable.value = true;
		rosterSelectable.value = [];
		rosterSystem.value = [];
		return;
	}
	const isClassifier = (id) => routingClassifierModel.value && id === routingClassifierModel.value;
	rosterEndpoint.value = info.endpoint;
	rosterSelectable.value = info.models.filter((id) => !isClassifier(id));
	rosterSystem.value = info.models.filter(isClassifier);
	rosterUnreachable.value = false;
}
async function saveRoutingConfig() {
	const res = await authFetch("/api/router/routes" + (routingCurrentRouter.value ? `?router=${encodeURIComponent(routingCurrentRouter.value)}` : ""), {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			routes: routingDraft.value.routes,
			default_route: routingDraft.value.default_route
		})
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || res.status);
	routingDraft.value = body;
	renderRouteList();
}
var decisionsApp = null;
function mountRoutingDecisions() {
	if (decisionsApp) return;
	const host = $("#routing-decisions-list");
	if (!host) return;
	decisionsApp = createApp(RoutingDecisions_default);
	decisionsApp.mount(host);
}
async function refreshRoutingDecisions() {
	if (!$("#routing-decisions-list")) return;
	mountRoutingDecisions();
	try {
		const res = await authFetch("/api/router/decisions?limit=60");
		if (!res.ok) throw new Error(String(res.status));
		let { decisions: decisions$1 } = await res.json();
		const cur = routingCurrentRouter.value ?? "auto";
		decisions$1 = decisions$1.filter((d) => (d.router ?? "auto") === cur).slice(0, 15);
		decisionsRouter.value = cur;
		decisions.value = decisions$1;
		decisionsPhase.value = decisions$1.length === 0 ? "empty" : "rows";
	} catch {
		decisions.value = [];
		decisionsPhase.value = "error";
	}
}
function wireRoutingPanel() {
	$("#roster-refresh-btn")?.addEventListener("click", runRosterRefresh);
	$("#route-detail-close")?.addEventListener("click", () => closeRouteDetail());
	$("#route-detail-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const isNew = selectedRouteIdx.value === -1;
		const r = isNew ? {
			name: "",
			description: "",
			model: ""
		} : routingDraft.value.routes[selectedRouteIdx.value ?? -1];
		if (!r) return;
		const prevName = r.name;
		r.name = ($("#route-name")?.value ?? "").trim();
		r.description = $("#route-description")?.value ?? "";
		if (!r.escalate) {
			r.model = $("#route-binding")?.value ?? "";
			r.pinned = $("#route-pinned")?.checked ?? false;
			if ($("#route-default")?.checked ?? false) routingDraft.value.default_route = r.name;
			else if (routingDraft.value.default_route === prevName) routingDraft.value.default_route = r.name;
		}
		if (isNew) {
			routingDraft.value.routes.push(r);
			selectedRouteIdx.value = routingDraft.value.routes.length - 1;
		}
		try {
			await saveRoutingConfig();
			showToast("Route saved — live now", { kind: "success" });
			if (isNew) closeRouteDetail();
			else {
				const title = $("#route-detail-title");
				if (title) title.textContent = r.name;
			}
		} catch (err) {
			if (isNew) {
				routingDraft.value.routes.pop();
				selectedRouteIdx.value = -1;
			}
			showToast("Save failed: " + err?.message, { kind: "error" });
		}
	});
	$("#route-delete")?.addEventListener("click", async () => {
		const r = routingDraft.value.routes[selectedRouteIdx.value ?? -1];
		if (!r) return;
		if (!await showConfirmModal({
			title: `Delete the route "${r.name || r.model || "unnamed"}"?`,
			confirmLabel: "Delete",
			destructive: true
		})) return;
		routingDraft.value.routes.splice(selectedRouteIdx.value, 1);
		try {
			await saveRoutingConfig();
			closeRouteDetail();
			showToast("Route removed");
		} catch (err) {
			showToast("Delete failed: " + err?.message, { kind: "error" });
			loadRoutingTab();
		}
	});
	$("#create-route-btn")?.addEventListener("click", () => openNewRouteDetail());
	async function runBench(inputEl, outEl) {
		const prompt = inputEl.value.trim();
		if (!prompt) return;
		outEl.hidden = false;
		outEl.classList.remove("err");
		outEl.textContent = "Classifying…";
		try {
			const res = await authFetch("/api/router/classify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			outEl.textContent = `→ ${body.route} · ${body.model ?? "(no binding)"} · ${body.ms} ms`;
		} catch (err) {
			outEl.classList.add("err");
			outEl.textContent = "Could not classify — " + (err?.message || "classifier unavailable");
		}
	}
	function wireBench(inputId, runId, outId) {
		const input = document.getElementById(inputId);
		const out = document.getElementById(outId);
		if (!input || !out) return;
		document.getElementById(runId)?.addEventListener("click", () => runBench(input, out));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") runBench(input, out);
		});
	}
	wireBench("routing-bench-input", "routing-bench-run", "routing-bench-result");
	wireBench("routing-bench-input-log", "routing-bench-run-log", "routing-bench-result-log");
}
function wireRoutingProfiles() {
	$("#router-delete-btn")?.addEventListener("click", async () => {
		const name = routingCurrentRouter.value;
		if (!name) return;
		if (!await showConfirmModal({
			title: "Delete routing profile",
			body: `Delete the "${name}" routing profile? Agents must be unassigned from it first.`,
			confirmLabel: "Delete",
			destructive: true
		})) return;
		try {
			const res = await authFetch("/api/router/routers/" + encodeURIComponent(name), { method: "DELETE" });
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || res.status);
			routingCurrentRouter.value = null;
			showToast(`Deleted "${name}"`);
			await fetchModels();
			loadRoutingTab();
		} catch (err) {
			showToast("Could not delete: " + err?.message, { kind: "error" });
		}
	});
}
function wireRouterNew() {
	$("#router-new-btn")?.addEventListener("click", async () => {
		const name = await showInputModal({
			title: "New routing profile",
			placeholder: "letters, digits, dash"
		});
		if (!name) return;
		try {
			const res = await authFetch("/api/router/routers", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || res.status);
			routingCurrentRouter.value = name;
			showToast(`Created routing profile "${name}" (cloned)`, { kind: "success" });
			await fetchModels();
			loadRoutingTab();
		} catch (err) {
			showToast("Could not create profile: " + err?.message, { kind: "error" });
		}
	});
}
var routeSuggestApp = null;
function mountRouteSuggestions() {
	if (routeSuggestApp) return;
	const host = $("#route-suggestions");
	if (!host) return;
	routeSuggestApp = createApp(RouteSuggestions_default, { onCreate: (s) => void createRouteFromSuggestion(s) });
	routeSuggestApp.mount(host);
}
async function renderRouteSuggestions() {
	const box = $("#route-suggestions");
	if (!box) return;
	let suggestions = [];
	try {
		const res = await authFetch("/api/router/suggestions");
		if (res.ok) suggestions = (await res.json()).suggestions || [];
	} catch {}
	routeSuggestions.value = suggestions;
	box.hidden = suggestions.length === 0;
	mountRouteSuggestions();
}
async function createRouteFromSuggestion(s) {
	if (!routingDraft.value) return;
	if (routingDraft.value.routes.some((r) => r.name === s.capability)) return;
	routeSuggestBusy.value = new Set(routeSuggestBusy.value).add(s.capability);
	routingDraft.value.routes.push({
		name: s.capability,
		description: s.description,
		model: s.model
	});
	try {
		await saveRoutingConfig();
		showToast(`Created ${s.capability} route → ${s.model}`, { kind: "success" });
		renderRouteSuggestions();
	} catch (err) {
		routingDraft.value.routes = routingDraft.value.routes.filter((r) => r.name !== s.capability);
		showToast("Could not create route: " + err?.message, { kind: "error" });
	} finally {
		const next = new Set(routeSuggestBusy.value);
		next.delete(s.capability);
		routeSuggestBusy.value = next;
	}
}
async function runRosterRefresh() {
	const btn = $("#roster-refresh-btn");
	const log = $("#roster-refresh-log");
	btn.disabled = true;
	log.hidden = false;
	log.textContent = "Starting…";
	try {
		const res = await authFetch("/api/router/roster-refresh", { method: "POST" });
		if (!res.ok) throw new Error((await res.json()).error || res.status);
		while (true) {
			await new Promise((r) => setTimeout(r, 2e3));
			const st = await (await authFetch("/api/router/roster-refresh")).json();
			log.textContent = st.lines.slice(-12).join("\n");
			log.scrollTop = log.scrollHeight;
			if (!st.running) {
				if (st.exitCode === 0) {
					showToast("Roster refreshed", { kind: "success" });
					setTimeout(() => {
						log.hidden = true;
					}, 4e3);
					loadRoutingTab();
				} else showToast("Roster refresh failed — see log", { kind: "error" });
				break;
			}
		}
	} catch (err) {
		log.textContent = "Refresh failed: " + err?.message;
		showToast("Roster refresh failed", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
var routeListApp = null;
function mountRouteList() {
	if (routeListApp) return;
	const host = $("#route-list");
	if (!host) return;
	routeListApp = createApp(RouteList_default, { onActivate: (i) => {
		if (selectedRouteIdx.value === i && !$("#route-detail").hidden) closeRouteDetail();
		else openRouteDetail(i);
	} });
	routeListApp.mount(host);
}
function renderRouteList() {
	if (!$("#route-list")) return;
	routeRows.value = routingDraft.value.routes;
	routeDefaultName.value = routingDraft.value.default_route || "";
	routeSelectedIdx.value = selectedRouteIdx.value ?? -1;
	mountRouteList();
	if ($("#route-detail").hidden) routeSelectedIdx.value = -1;
}
function openRouteDetail(i) {
	const r = routingDraft.value.routes[i ?? -1];
	if (!r) return;
	selectedRouteIdx.value = i;
	populateRouteDetail(r, false);
}
function openNewRouteDetail() {
	if (!routingDraft.value) return;
	selectedRouteIdx.value = -1;
	populateRouteDetail({
		name: "",
		description: "",
		model: (routingRouterInfo.value?.models ?? [])[0] || ""
	}, true);
}
function populateRouteDetail(r, isNew) {
	closeModelDetail();
	renderRouteList();
	$("#route-detail-title").textContent = isNew ? "New route" : r.name;
	const badge = $("#route-detail-badge");
	badge.hidden = !r.escalate;
	if (r.escalate) {
		badge.className = "model-kind-badge kind-anthropic";
		badge.textContent = "escalate";
	}
	$("#route-name").value = r.name;
	$("#route-description").value = r.description || "";
	$("#route-binding-label").hidden = Boolean(r.escalate);
	$("#route-escalate-note").hidden = !r.escalate;
	if (!r.escalate) {
		const sel = $("#route-binding");
		sel.innerHTML = "";
		for (const m of [.../* @__PURE__ */ new Set([r.model, ...routingRouterInfo.value?.models ?? []])].filter(Boolean)) {
			const o = document.createElement("option");
			o.value = m;
			o.textContent = m;
			if (m === r.model) o.selected = true;
			sel.appendChild(o);
		}
	}
	const pin = $("#route-pinned");
	pin.checked = Boolean(r.pinned);
	pin.parentElement.hidden = Boolean(r.escalate);
	const def = $("#route-default");
	def.checked = routingDraft.value.default_route === r.name;
	def.disabled = def.checked;
	def.parentElement.hidden = Boolean(r.escalate);
	$("#route-detail").hidden = false;
	$("#members-panel").hidden = true;
}
function closeRouteDetail() {
	$("#route-detail").hidden = true;
	selectedRouteIdx.value = null;
	if (routingDraft.value) renderRouteList();
}
//#endregion
//#region src/features/OllamaHostCards.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$6 = ["id", "data-host"];
var _hoisted_2$4 = ["onClick"];
var _hoisted_3$4 = { class: "ollama-host-name" };
var _hoisted_4$2 = ["hidden"];
var _hoisted_5$1 = ["hidden"];
var _hoisted_6$1 = { class: "ollama-model-list" };
var _hoisted_7$1 = {
	key: 0,
	class: "ollama-muted"
};
var _hoisted_8 = {
	key: 1,
	class: "ollama-muted"
};
var _hoisted_9 = {
	key: 2,
	class: "ollama-muted"
};
var _hoisted_10 = { class: "ollama-model-name" };
var _hoisted_11 = { class: "ollama-model-meta" };
var _hoisted_12 = ["title"];
var _hoisted_13 = ["aria-label", "onClick"];
var _hoisted_14 = { class: "ollama-model-name" };
var _hoisted_15 = { class: "ollama-model-meta" };
var _hoisted_16 = ["title"];
var _hoisted_17 = { class: "ollama-pull-row" };
var _hoisted_18 = ["onKeydown", "onInput"];
var _hoisted_19 = ["onClick"];
var _hoisted_20 = ["hidden"];
var _hoisted_21 = { class: "ollama-pull-line progress" };
var _hoisted_22 = { class: "ollama-pull-text" };
var _hoisted_23 = ["onClick"];
var _hoisted_24 = { class: "ollama-pull-bar" };
var _hoisted_25 = { class: "ollama-pull-line ok" };
var _hoisted_26 = {
	key: 2,
	class: "ollama-pull-line"
};
var _hoisted_27 = {
	key: 3,
	class: "ollama-pull-line err"
};
var LOADING = "Loading…";
var NO_MODELS = "No models installed";
var SYS_HEADING = "System — not selectable";
var CLASSIFIER = "classifier";
var CLASSIFIER_TITLE = "Auto-routing classifier — infrastructure, not selectable as an agent model";
var PULL = "Pull";
var CANCEL = "Cancel";
var PULL_PLACEHOLDER = "Model to pull, e.g. qwen3.5:4b…";
var CHEVRON = "›";
var DOTS = "…";
//#endregion
//#region src/features/OllamaHostCards.vue
var OllamaHostCards_default = /* @__PURE__ */ defineComponent({
	__name: "OllamaHostCards",
	props: {
		onRemove: { type: Function },
		onCancel: { type: Function },
		onPreview: { type: Function },
		onPull: { type: Function }
	},
	setup(__props) {
		/**
		* The Ollama host cards — twenty-fifth island, and the first CLUSTER one.
		*
		* Mounted into <div id="ollama-host-cards">, exclusively owned by this module.
		*
		* Three renderers previously shared this subtree: buildOllamaHostCard made the
		* card, loadOllamaHostModels filled .ollama-model-list, renderOllamaPulls filled
		* .ollama-pull-status. Each rebuilt or overwrote elements the others owned, so
		* none could convert alone. They are three slices of one state object now.
		*
		* Element ORDER is load-bearing and matches the builder exactly: head, then the
		* accordion body (model list + pull row), then the pull status OUTSIDE the body
		* so progress stays visible while the card is collapsed.
		*
		* The chevron is first inside the head because makeCardAccordion prepended it.
		*/
		const props = __props;
		const cards = computed(() => hosts.value.map((host) => {
			const m = hostModels.value[host];
			const open = openCards.value.has(host);
			const rows = (list) => list.map((x) => ({
				name: x.name,
				meta: typeof x.size === "number" ? (x.size / 1e9).toFixed(1) + " GB" : "—",
				loaded: !!x.loaded,
				vram: typeof x.size_vram === "number" ? (x.size_vram / 1e9).toFixed(1) + " GB in VRAM" : ""
			}));
			return {
				host,
				id: ollamaCardId(host),
				label: host.replace(/^https?:\/\//, ""),
				open,
				summary: !m || m.phase === "loading" ? DOTS : m.phase === "error" ? "" : countLabel(m),
				phase: m ? m.phase : "loading",
				error: m ? m.error : "",
				selectable: m ? rows(m.selectable) : [],
				system: m ? rows(m.system) : [],
				pull: hostPulls.value[host] || null,
				preview: hostPullPreview.value[host] || null
			};
		}));
		function countLabel(m) {
			const n = m.selectable.length + m.system.length;
			return n + " model" + (n === 1 ? "" : "s");
		}
		/** Card actions keep working — a click on a button must not toggle the card. */
		function toggle(host, e) {
			if (e.target.closest("button")) return;
			setCardOpen(host, !openCards.value.has(host));
		}
		function pull(host, e) {
			const row = e.currentTarget.closest(".ollama-pull-row");
			const input = row.querySelector(".ollama-pull-input");
			props.onPull(host, input.value.trim(), input, row.querySelector("button"));
		}
		function pullKey(host, e) {
			if (e.key !== "Enter") return;
			const row = e.currentTarget.closest(".ollama-pull-row");
			const input = row.querySelector(".ollama-pull-input");
			props.onPull(host, input.value.trim(), input, row.querySelector("button"));
		}
		function preview(host, e) {
			props.onPreview(host, e.target.value);
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(cards.value, (c) => {
				return openBlock(), createElementBlock("div", {
					key: c.host,
					class: "ollama-host-card",
					id: c.id,
					"data-host": c.host
				}, [
					createElementVNode("div", {
						class: "ollama-host-head clickable",
						role: "button",
						tabindex: "0",
						onClick: ($event) => toggle(c.host, $event)
					}, [
						createElementVNode("span", { class: normalizeClass(c.open ? "ollama-card-chevron open" : "ollama-card-chevron") }, toDisplayString(CHEVRON), 2),
						createElementVNode("span", _hoisted_3$4, toDisplayString(c.label), 1),
						createElementVNode("span", {
							class: "ollama-card-summary",
							hidden: c.open
						}, toDisplayString(c.summary), 9, _hoisted_4$2)
					], 8, _hoisted_2$4),
					createElementVNode("div", { hidden: !c.open }, [
						createElementVNode("ul", _hoisted_6$1, [c.phase === "loading" ? (openBlock(), createElementBlock("li", _hoisted_7$1, toDisplayString(LOADING))) : c.phase === "error" ? (openBlock(), createElementBlock("li", _hoisted_8, toDisplayString(c.error), 1)) : c.selectable.length === 0 && c.system.length === 0 ? (openBlock(), createElementBlock("li", _hoisted_9, toDisplayString(NO_MODELS))) : (openBlock(), createElementBlock(Fragment, { key: 3 }, [(openBlock(true), createElementBlock(Fragment, null, renderList(c.selectable, (m) => {
							return openBlock(), createElementBlock("li", { key: m.name }, [
								createElementVNode("span", _hoisted_10, toDisplayString(m.name), 1),
								createElementVNode("span", _hoisted_11, toDisplayString(m.meta), 1),
								m.loaded ? (openBlock(), createElementBlock("span", {
									key: 0,
									class: "ollama-loaded-badge",
									title: m.vram
								}, "in memory", 8, _hoisted_12)) : createCommentVNode("", true),
								createVNode(SelectToggle_default, {
									kind: "ollama",
									endpoint: c.host,
									"model-id": m.name,
									"display-name": m.name
								}, null, 8, [
									"endpoint",
									"model-id",
									"display-name"
								]),
								createElementVNode("button", {
									class: "ollama-model-remove",
									type: "button",
									"aria-label": `Remove ${m.name} from this server`,
									title: "Remove from server…",
									onClick: ($event) => props.onRemove(c.host, m.name)
								}, "✕", 8, _hoisted_13)
							]);
						}), 128)), c.system.length ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("li", { class: "ollama-model-sysheading" }, toDisplayString(SYS_HEADING)), (openBlock(true), createElementBlock(Fragment, null, renderList(c.system, (m) => {
							return openBlock(), createElementBlock("li", { key: m.name }, [
								createElementVNode("span", _hoisted_14, toDisplayString(m.name), 1),
								createElementVNode("span", _hoisted_15, toDisplayString(m.meta), 1),
								m.loaded ? (openBlock(), createElementBlock("span", {
									key: 0,
									class: "ollama-loaded-badge",
									title: m.vram
								}, "in memory", 8, _hoisted_16)) : createCommentVNode("", true),
								createElementVNode("span", {
									class: "ollama-model-systag",
									title: CLASSIFIER_TITLE
								}, toDisplayString(CLASSIFIER))
							]);
						}), 128))], 64)) : createCommentVNode("", true)], 64))]),
						createElementVNode("div", _hoisted_17, [createElementVNode("input", {
							type: "text",
							placeholder: PULL_PLACEHOLDER,
							class: "ollama-pull-input",
							onKeydown: ($event) => pullKey(c.host, $event),
							onInput: ($event) => preview(c.host, $event)
						}, null, 40, _hoisted_18), createElementVNode("button", {
							class: "btn btn-secondary",
							type: "button",
							onClick: ($event) => pull(c.host, $event)
						}, toDisplayString(PULL), 8, _hoisted_19)]),
						c.preview ? (openBlock(), createElementBlock("div", {
							key: 0,
							class: normalizeClass(["ollama-pull-preview", { warn: c.preview.warn }])
						}, toDisplayString(c.preview.text), 3)) : createCommentVNode("", true)
					], 8, _hoisted_5$1),
					createElementVNode("div", {
						class: "ollama-pull-status",
						hidden: !c.pull
					}, [c.pull ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [c.pull.status === "pulling" ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("div", _hoisted_21, [createElementVNode("span", _hoisted_22, "Pulling " + toDisplayString(c.pull.model) + " — " + toDisplayString(c.pull.detail), 1), createElementVNode("button", {
						class: "ollama-pull-cancel",
						type: "button",
						onClick: ($event) => props.onCancel(c.host, c.pull.model)
					}, toDisplayString(CANCEL), 8, _hoisted_23)]), createElementVNode("div", _hoisted_24, [createElementVNode("span", { style: normalizeStyle({ width: c.pull.pct + "%" }) }, null, 4)])], 64)) : c.pull.status === "success" ? (openBlock(), createElementBlock(Fragment, { key: 1 }, [createElementVNode("div", _hoisted_25, "Pulled " + toDisplayString(c.pull.model), 1), (openBlock(true), createElementBlock(Fragment, null, renderList(c.pull.verdict || [], (v) => {
						return openBlock(), createElementBlock("div", {
							key: v,
							class: "ollama-pull-line pull-verdict"
						}, toDisplayString(v), 1);
					}), 128))], 64)) : c.pull.status === "cancelled" ? (openBlock(), createElementBlock("div", _hoisted_26, " Cancelled pull of " + toDisplayString(c.pull.model), 1)) : (openBlock(), createElementBlock("div", _hoisted_27, "Pull of " + toDisplayString(c.pull.model) + " failed: " + toDisplayString(c.pull.error), 1))], 64)) : createCommentVNode("", true)], 8, _hoisted_20)
				], 8, _hoisted_1$6);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/ollama-cards.ts
var cardsApp = null;
function mountOllamaHostCards() {
	if (cardsApp) return;
	const host = $("#ollama-host-cards");
	if (!host) return;
	cardsApp = createApp(OllamaHostCards_default, {
		onPull: (h, model, input, btn) => startOllamaPull(h, model, input, btn),
		onRemove: (h, model) => void removeHostModel(h, model),
		onCancel: (h, model) => void cancelOllamaPull(h, model),
		onPreview: (h, model) => previewOllamaPull(h, model)
	});
	cardsApp.mount(host);
}
function ollamaCardId(host) {
	return "ollama-card-" + host.replace(/[^a-z0-9]/gi, "-");
}
async function loadOllamaHosts() {
	const wrap = $("#ollama-hosts");
	if (!wrap) return;
	if (routingClassifierModel.value === null) await probeRoutingAvailability();
	try {
		const hostsRes = await authFetch("/api/ollama/hosts");
		if (!hostsRes.ok) {
			wrap.hidden = true;
			return;
		}
		const { hosts: hosts$1 } = await hostsRes.json();
		wrap.hidden = hosts$1.length === 0;
		if (wrap.hidden) return;
		syncOpenCards(hosts$1);
		hosts.value = hosts$1;
		for (const host of hosts$1) hostModels.value[host] = {
			phase: "loading",
			selectable: [],
			system: [],
			error: ""
		};
		mountOllamaHostCards();
		for (const host of hosts$1) loadOllamaHostModels(host);
		pollOllamaPulls();
	} catch (err) {
		console.error("Failed to load servers:", err);
		wrap.hidden = true;
	}
}
/**
* Remove a model's files from an Ollama host — the undo of a pull, so it gets
* the same weight of ceremony: a destructive confirm carrying what the delete
* MEANS, not just what it does. A model still registered in webchat keeps its
* registry row (which then shows as not-pulled) — that is stated in the
* confirm rather than silently breaking an agent.
*/
async function removeHostModel(host, model) {
	const registered = allModels.value.some((m) => m.kind === "ollama" && m.model_id === model && (m.endpoint || "").startsWith(host));
	const bodyEl = document.createElement("div");
	const line = (text) => {
		const d = document.createElement("div");
		d.className = "cred-hint";
		d.textContent = text;
		bodyEl.appendChild(d);
	};
	line(`Deletes the model files from ${host} — frees the disk space, and re-downloading means a full pull.`);
	if (registered) line("⚠ This model is registered in webchat — agents assigned to it will fail until it is pulled again or they are reassigned.");
	if (!await showConfirmModal({
		title: `Remove ${model} from this server?`,
		body: bodyEl,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		const res = await authFetch("/api/ollama/delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				host,
				model
			})
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
		showToast(`Removed ${model}`, { kind: "success" });
		loadOllamaHostModels(host);
	} catch (err) {
		showToast("Remove failed: " + (err?.message || err), { kind: "error" });
	}
}
//#endregion
//#region src/features/models.ts
var deps$5 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideModelsDeps(provided) {
	Object.assign(deps$5, provided);
}
function sttPopulateModelSelect(st) {
	const select = $("#stt-model-select");
	if (!select || !Array.isArray(st.models)) return;
	if (select.options.length === 0) for (const m of st.models) {
		const opt = document.createElement("option");
		opt.value = m;
		opt.textContent = m === st.suggestedModel ? `${m} (suggested)` : m;
		select.appendChild(opt);
	}
	select.value = st.model || st.suggestedModel || st.models[0];
}
var knownModelOptions = null;
async function populateKnownModelOptions() {
	const list = $("#agent-config-model-options");
	if (!list) return;
	if (knownModelOptions === null) try {
		const res = await authFetch("/api/models/known");
		knownModelOptions = res.ok ? (await res.json()).models || [] : [];
	} catch {
		knownModelOptions = [];
	}
	if (list.childElementCount === knownModelOptions.length) return;
	list.textContent = "";
	for (const id of knownModelOptions) {
		const opt = document.createElement("option");
		opt.value = id;
		list.appendChild(opt);
	}
}
async function fetchModels() {
	try {
		allModels.value = await (await authFetch("/api/models")).json();
		renderModels();
		loadOllamaHosts();
	} catch (err) {
		console.error("Failed to fetch models:", err);
	}
}
async function loadOllamaHostModels(host) {
	try {
		const res = await authFetch("/api/ollama/models?host=" + encodeURIComponent(host));
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		const isClassifier = (m) => routingClassifierModel.value && m.name === routingClassifierModel.value;
		hostModels.value[host] = {
			phase: "ready",
			selectable: body.models.filter((m) => !isClassifier(m)),
			system: body.models.filter(isClassifier),
			error: ""
		};
	} catch (err) {
		hostModels.value[host] = {
			phase: "error",
			selectable: [],
			system: [],
			error: "Unreachable: " + err?.message
		};
	}
}
function modelKindLabel(kind) {
	return kind === "openai-compatible" ? "openai" : kind;
}
function isRouterBackendModel(m) {
	if (m.kind !== "openai-compatible" || m.model_id === "auto") return false;
	const host = (m.endpoint || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
	return /:4000(\/v1)?$/.test(host);
}
function modelDisplayParts(model) {
	const host = model.endpoint ? model.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
	let title = model.name;
	if (host && title.startsWith(host + " · ")) title = title.slice(host.length + 3);
	return {
		title,
		host
	};
}
function modelKindExplainer(kind) {
	if (kind === "anthropic") return "Anthropic model — credentials injected per request by the OneCLI gateway.";
	return "";
}
var modelListApp = null;
/** Mount the ModelList island into <ul id="model-list">, once. */
function mountModelList() {
	if (modelListApp) return;
	const host = $("#model-list");
	if (!host) return;
	modelListApp = createApp(ModelList_default, {
		onPick: (id) => {
			if (allModels.value.find((m) => m.id === id)?.model_id === "auto") {
				if (routingAvailable.value) deps$5.switchManageTab("routing");
				else openModelDetail(id);
				return;
			}
			const detail = $("#model-detail");
			if (selectedModelId.value === id && detail && !detail.hidden) closeModelDetail();
			else openModelDetail(id);
		},
		onRemove: async (id, btn) => {
			btn.disabled = true;
			try {
				const r = await authFetch("/api/models/" + encodeURIComponent(id), { method: "DELETE" });
				if (!r.ok) {
					const body = await r.json().catch(() => ({}));
					const who = (allModels.value.find((m) => m.id === id)?.agents || []).map((a) => a.name).join(", ");
					throw new Error(who ? "in use by " + who + " — unassign first" : body.error || r.status);
				}
				showToast("Removed from selectable models");
				if (selectedModelId.value === id) closeModelDetail();
				fetchModels();
			} catch (err) {
				showToast(String(err?.message || err), { kind: "error" });
				btn.disabled = false;
			}
		}
	});
	modelListApp.mount(host);
	watchEffect(() => {
		const btn = $("#create-model-btn");
		if (btn) btn.hidden = !state.isOwnerView;
	});
}
function renderModels() {
	const visible = allModels.value.filter((m) => !isRouterBackendModel(m));
	const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));
	modelRows.value = (modelSortAz.value ? [...visible].sort(byName) : [...visible].sort((a, b) => (a.kind === "anthropic" ? 0 : 1) - (b.kind === "anthropic" ? 0 : 1) || byName(a, b))).map((model) => {
		const isAuto = model.model_id === "auto";
		const parts = modelDisplayParts(model);
		return {
			id: model.id,
			badgeKind: isAuto ? "auto" : model.kind,
			badgeText: isAuto ? "auto" : modelKindLabel(model.kind),
			title: parts.title,
			host: isAuto ? null : parts.host ?? null,
			hint: isAuto ? "Manage in Auto routing →" : null,
			uses: model.agents_assigned ?? 0,
			active: model.id === selectedModelId.value
		};
	});
	mountModelList();
}
var modelUsageApp = null;
function mountModelUsage() {
	if (modelUsageApp) return;
	const host = $("#model-detail-usage");
	if (!host) return;
	modelUsageApp = createApp(ModelUsage_default);
	modelUsageApp.mount(host);
}
async function openModelDetail(id) {
	const model = allModels.value.find((m) => m.id === id);
	if (!model) return;
	selectedModelId.value = id;
	renderModels();
	if (typeof deps$5.closeRouteDetail === "function") deps$5.closeRouteDetail();
	closeAgentDetail();
	closeRoomDetail();
	closeMcpDetail();
	$("#model-edit-view").hidden = false;
	$("#model-create-view").hidden = true;
	const parts = modelDisplayParts(model);
	$("#model-detail-title").textContent = parts.title;
	const badge = $("#model-detail-badge");
	badge.textContent = modelKindLabel(model.kind);
	badge.className = `model-kind-badge kind-${model.kind}`;
	badge.hidden = false;
	const kindExplainer = modelKindExplainer(model.kind);
	$("#model-kind-explainer").textContent = kindExplainer;
	$("#model-kind-explainer").hidden = !kindExplainer;
	$("#model-name").value = model.name;
	$("#model-kind").value = modelKindLabel(model.kind);
	$("#model-kind").dataset.kind = model.kind;
	$("#model-endpoint").value = model.endpoint || "";
	$("#model-endpoint-label").hidden = model.kind !== "ollama";
	$("#model-model-id").value = model.model_id;
	$("#model-discover-select").hidden = true;
	loadModelLiveFacts(model);
	renderReachabilityPanel(model);
	modelAssignees.value = (model.agents || []).map((a) => a.name);
	mountModelUsage();
	const roomsEl = $("#model-detail-rooms");
	roomsEl.innerHTML = "";
	if (model.rooms && model.rooms.length > 0) {
		roomsEl.hidden = false;
		roomsEl.appendChild(document.createTextNode("In rooms: "));
		for (const r of model.rooms) {
			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "model-assignee-chip model-room-chip";
			chip.textContent = r.name;
			chip.title = "Open room settings";
			chip.addEventListener("click", () => openRoomDetail(r.id));
			roomsEl.appendChild(chip);
		}
	} else roomsEl.hidden = true;
	$("#model-detail").hidden = false;
	$("#members-panel").hidden = true;
}
async function loadModelLiveFacts(model) {
	const el = $("#model-live-facts");
	el.hidden = true;
	el.classList.remove("warn");
	if (model.kind !== "ollama" || !model.endpoint) return;
	try {
		const res = await authFetch("/api/ollama/models?host=" + encodeURIComponent(model.endpoint));
		if (!res.ok) return;
		const { models } = await res.json();
		if (selectedModelId.value !== model.id) return;
		const hit = models.find((m) => m.name === model.model_id);
		if (!hit) {
			el.textContent = "Not installed on this endpoint — pull it below or pick another model id.";
			el.classList.add("warn");
		} else {
			const gb = (hit.size / 1e9).toFixed(1);
			el.textContent = hit.loaded ? `Installed \u00b7 ${gb} GB \u00b7 in memory (${(hit.size_vram / 1e9).toFixed(1)} GB VRAM)` : `Installed \u00b7 ${gb} GB`;
		}
		el.hidden = false;
	} catch {}
}
function closeModelDetail() {
	$("#model-detail").hidden = true;
	$("#model-edit-view").hidden = false;
	$("#model-create-view").hidden = true;
	selectedModelId.value = null;
	renderModels();
}
async function discoverModels(kind, endpoint) {
	const res = await authFetch("/api/models/discover", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(kind === "anthropic" ? { kind } : {
			kind,
			endpoint
		})
	});
	const out = await res.json();
	if (!res.ok) throw new Error(out.error || "discover failed");
	return out.models || [];
}
function openModelPicker() {
	const picker = $("#model-picker");
	picker.hidden = false;
	picker.offsetHeight;
	picker.classList.add("open");
	$("#model-picker-search").value = "";
	renderPickerList("");
	if (window.matchMedia("(min-width: 720px)").matches) setTimeout(() => $("#model-picker-search").focus(), 60);
}
function closeModelPicker() {
	const picker = $("#model-picker");
	picker.classList.remove("open");
	setTimeout(() => {
		picker.hidden = true;
	}, 220);
}
function bindDiscover(buttonId, kindGetter, endpointGetter, modelIdInput, selectEl) {
	const btn = $(buttonId);
	if (!btn) return;
	btn.addEventListener("click", async () => {
		const kind = kindGetter();
		const endpoint = endpointGetter();
		if (kind === "ollama" && !endpoint) {
			showToast("Enter an Ollama endpoint first (e.g. http://localhost:11434)", { kind: "error" });
			return;
		}
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = "…";
		try {
			const models = await discoverModels(kind, endpoint);
			const select = $(selectEl);
			if (!select) return;
			select.innerHTML = "<option value=\"\">— pick a model —</option>";
			for (const m of models) {
				const opt = document.createElement("option");
				opt.value = m;
				opt.textContent = m;
				select.appendChild(opt);
			}
			select.hidden = models.length === 0;
			if (models.length === 0) showToast("No models found at that endpoint.", { kind: "error" });
			select.onchange = () => {
				const target = $(modelIdInput);
				if (select.value && target) {
					target.value = select.value;
					select.hidden = true;
				}
			};
		} catch (err) {
			showToast("Discover failed: " + err?.message, { kind: "error" });
		} finally {
			btn.disabled = false;
			btn.textContent = original;
		}
	});
}
function wireModelsPanel() {
	bindDiscover("#model-discover-btn", () => $("#model-kind")?.dataset.kind || ($("#model-kind")?.value ?? ""), () => ($("#model-endpoint")?.value ?? "").trim(), "#model-model-id", "#model-discover-select");
	$("#model-create-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const body = {
			name: ($("#model-create-name")?.value ?? "").trim(),
			kind: $("#model-create-kind")?.value ?? "",
			model_id: ($("#model-create-model-id")?.value ?? "").trim(),
			endpoint: ($("#model-create-endpoint")?.value ?? "").trim() || null
		};
		if (!body.name || !body.model_id) {
			showToast("Name and Model ID are required.", { kind: "error" });
			return;
		}
		try {
			const res = await authFetch("/api/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			const out = await res.json();
			if (!res.ok) {
				showToast("Failed to create model: " + (out.error || res.statusText), { kind: "error" });
				return;
			}
			warnIfUnreachable(out.reachability);
			await fetchModels();
			closeModelDetail();
			const createdId = out.model && out.model.id;
			if (createdId) await maybeAssignAfterPickerAdd([createdId]);
		} catch (err) {
			showToast("Failed to create model: " + err?.message, { kind: "error" });
		}
	});
	$("#model-detail-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!selectedModelId.value) return;
		const btn = $("#model-detail-form button.btn-primary");
		if (!btn) return;
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = "Saving…";
		btn.classList.remove("success");
		const patch = {
			name: ($("#model-name")?.value ?? "").trim(),
			model_id: ($("#model-model-id")?.value ?? "").trim(),
			endpoint: ($("#model-endpoint")?.value ?? "").trim() || null
		};
		try {
			const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch)
			});
			const out = await res.json();
			if (!res.ok) {
				showToast("Failed to save model: " + (out.error || res.statusText), { kind: "error" });
				btn.textContent = original;
				btn.disabled = false;
				return;
			}
			await fetchModels();
			btn.textContent = "✓ Saved";
			btn.classList.add("success");
			setTimeout(() => {
				if (btn.isConnected) {
					btn.textContent = original;
					btn.classList.remove("success");
					btn.disabled = false;
				}
			}, 1500);
		} catch (err) {
			showToast("Failed to save model: " + err?.message, { kind: "error" });
			btn.textContent = original;
			btn.disabled = false;
		}
	});
	$("#model-delete")?.addEventListener("click", async () => {
		if (!selectedModelId.value) return;
		const model = allModels.value.find((m) => m.id === selectedModelId.value);
		if (!model) return;
		try {
			const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}`, { method: "DELETE" });
			if (res.status === 409) {
				const impact = await res.json();
				const n = (impact.assigned_agent_group_ids || []).length;
				const routes = impact.routes_bound || [];
				const parts = [];
				if (n > 0) parts.push(`"${model.name}" is assigned to ${n} agent${n === 1 ? "" : "s"} — they fall back to the default model on their next spawn.`);
				if (routes.length > 0) parts.push(`Also removes routing rule${routes.length === 1 ? "" : "s"}: ` + routes.map((r) => `${r.route} (${r.router})`).join(", ") + ".");
				if (!await showConfirmModal({
					title: "Delete model",
					body: parts.join(" ") || impact.error || "This model is in use.",
					confirmLabel: "Delete anyway",
					destructive: true
				})) return;
				const force = await authFetch(`/api/models/${encodeURIComponent(selectedModelId.value)}?force=1`, { method: "DELETE" });
				if (!force.ok) {
					showToast(`Failed to delete: ${(await force.json().catch(() => ({}))).error || force.statusText}`, { kind: "error" });
					return;
				}
			} else if (!res.ok) {
				showToast(`Failed to delete: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
				return;
			}
			showToast(`Deleted model "${model.name}".`, { kind: "success" });
			closeModelDetail();
			await fetchModels();
			if (state.allAgents.length > 0) await fetchAgents();
		} catch (err) {
			showToast(`Failed to delete: ${err?.message}`, { kind: "error" });
		}
	});
}
function wireModelCreate() {
	$("#create-model-btn")?.addEventListener("click", () => {
		selectedModelId.value = null;
		renderModels();
		const el1 = $("#model-edit-view");
		if (el1) el1.hidden = true;
		const el2 = $("#model-create-view");
		if (el2) el2.hidden = false;
		const _el1 = $("#model-create-name");
		if (_el1) _el1.value = "";
		const _el2 = $("#model-create-endpoint");
		if (_el2) _el2.value = "";
		const _el3 = $("#model-create-model-id");
		if (_el3) _el3.value = "";
		const h1 = $("#model-create-discover-select");
		if (h1) h1.hidden = true;
		const _el4 = $("#model-create-kind");
		if (_el4) _el4.value = "anthropic";
		syncCreateFormToKind();
		const _el5 = $("#model-probe-url");
		if (_el5) _el5.value = "";
		const el3 = $("#model-probe-status");
		if (el3) el3.hidden = true;
		const el4 = $("#model-probe-results");
		if (el4) el4.hidden = true;
		lastProbeResult.value = null;
		const el5 = $("#model-detail");
		if (el5) el5.hidden = false;
		const el6 = $("#members-panel");
		if (el6) el6.hidden = true;
		$("#model-probe-url")?.focus();
	});
}
function syncCreateFormToKind() {
	const kind = $("#model-create-kind").value;
	$("#model-create-endpoint-label").hidden = kind === "anthropic";
	const placeholders = {
		anthropic: "claude-sonnet-4-6",
		ollama: "llama3.1:70b",
		"openai-compatible": "gpt-4o-mini or qwen2.5:14b"
	};
	$("#model-create-model-id").placeholder = placeholders[kind] || "";
}
function mmFmtGB(bytes) {
	return bytes == null ? "?" : (bytes / 1e9).toFixed(1) + " GB";
}
var REACH_META = {
	ok: {
		label: "Reachable",
		warn: false
	},
	timeout: {
		label: "Blocked (timeout)",
		warn: true
	},
	refused: {
		label: "Refused",
		warn: true
	},
	dns: {
		label: "Can't resolve",
		warn: true
	},
	incompatible: {
		label: "Reachable, wrong API",
		warn: true
	},
	skipped: {
		label: "Not preflighted",
		warn: false
	},
	error: {
		label: "Probe error",
		warn: true
	}
};
function warnIfUnreachable(result) {
	if (!result || !REACH_META[result.verdict] || !REACH_META[result.verdict].warn) return;
	showToast(`Agent containers can't reach this model — ${result.detail} Open the model to see the fix.`, {
		kind: "error",
		timeout: 1e4
	});
}
var reachabilityReqSeq = 0;
var reachabilityApp = null;
function mountReachability(panel) {
	if (reachabilityApp) return;
	reachabilityApp = createApp(Reachability_default, { onCopy: async (text) => {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			showToast("Copy failed — select the text manually.", { kind: "error" });
			return false;
		}
	} });
	reachabilityApp.mount(panel);
}
async function renderReachabilityPanel(model) {
	const facts = $("#model-live-facts");
	if (!facts) return;
	let panel = $("#model-reachability-panel");
	if (!panel) {
		panel = document.createElement("div");
		panel.id = "model-reachability-panel";
		panel.className = "model-reachability";
		facts.insertAdjacentElement("afterend", panel);
	}
	if (!model.endpoint) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	reachPhase.value = "checking";
	reachOutcome.value = null;
	mountReachability(panel);
	const reqId = ++reachabilityReqSeq;
	try {
		const res = await authFetch("/api/models/reachability", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: model.endpoint })
		});
		if (reqId !== reachabilityReqSeq || selectedModelId.value !== model.id) return;
		const result = await res.json();
		if (!res.ok) {
			reachError.value = result.error || res.statusText;
			reachPhase.value = "error";
			return;
		}
		const meta = REACH_META[result.verdict] || REACH_META.error;
		reachOutcome.value = {
			warn: !!meta.warn,
			label: meta.label,
			detail: result.detail,
			fix: result.fix || ""
		};
		reachPhase.value = "outcome";
	} catch (err) {
		if (reqId !== reachabilityReqSeq) return;
		reachError.value = String(err?.message || err);
		reachPhase.value = "error";
	}
}
var pickerAddInProgress = false;
var pickerAgentForAdd = null;
var modelPickerApp = null;
function mountModelPicker() {
	if (modelPickerApp) return;
	const host = $("#model-picker-list");
	if (!host) return;
	modelPickerApp = createApp(ModelPicker_default, { onPick: (id) => selectFromPicker(id) });
	modelPickerApp.mount(host);
}
function renderPickerList(filterText) {
	if (!$("#model-picker-list")) return;
	const q = (filterText || "").trim().toLowerCase();
	pickerSelected.value = $("#agent-model").value || "";
	const derived = state.allAgents.find((a) => a.id === selectedAgentId.value)?.effective_model_label;
	const matches = allModels.value.filter((m) => {
		if (isRouterBackendModel(m)) return false;
		if (!q) return true;
		const host = endpointHost(m.endpoint).toLowerCase();
		return [
			m.name,
			m.model_id,
			host,
			m.kind
		].some((s) => (s || "").toLowerCase().includes(q));
	});
	pickerEmptyNote.value = allModels.value.length === 0 ? "No models registered yet. Use \"+ Add new model\" below." : matches.length === 0 && q ? `No models match "${filterText}".` : "";
	pickerRows.value = [{
		key: "__default__",
		id: "",
		isDefault: true,
		name: "Default",
		badgeClass: "model-kind-badge model-default-badge",
		badgeText: "default",
		sub: derived ? `${derived} · auto-detected` : "Built-in Anthropic"
	}, ...matches.map((m) => {
		const host = endpointHost(m.endpoint);
		return {
			key: m.id,
			id: m.id,
			isDefault: false,
			name: m.name,
			badgeClass: `model-kind-badge kind-${m.kind}`,
			badgeText: modelKindLabel(m.kind),
			sub: host ? `${m.model_id} · ${host}` : m.model_id
		};
	})];
	mountModelPicker();
}
function selectFromPicker(modelId) {
	$("#agent-model").value = modelId;
	refreshAgentModelTrigger();
	refreshAgentSaveDirty();
	closeModelPicker();
}
/**
* Called from both the manual create and the probe bulk-add success paths.
* If the picker initiated this add, assign the newly-created model to the
* agent and return the user to the agent detail. Bulk-add of >1 doesn't
* auto-assign — we leave the user on the agent detail and they can re-open
* the picker to choose explicitly.
*/
async function maybeAssignAfterPickerAdd(createdIds) {
	if (!pickerAddInProgress) return false;
	const agentId = pickerAgentForAdd;
	pickerAddInProgress = false;
	pickerAgentForAdd = null;
	if (!agentId) return false;
	if (createdIds.length === 1) try {
		const mRes = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: createdIds[0] })
		});
		if (mRes.ok) warnIfUnreachable((await mRes.json()).reachability);
	} catch (err) {
		console.error("Auto-assign new model failed:", err);
	}
	await fetchAgents();
	if (typeof openAgentDetail === "function") await openAgentDetail(agentId);
	return true;
}
/** The picker's "+ Add new model" flow sets these from legacy's wiring block,
*  which cannot assign an imported binding — so it goes through a setter. */
function setPickerAdd(inProgress, agentId) {
	pickerAddInProgress = inProgress;
	pickerAgentForAdd = agentId;
}
var probeResultsApp = null;
function mountProbeResults() {
	if (probeResultsApp) return;
	const host = $("#model-probe-list");
	if (!host) return;
	probeResultsApp = createApp(ProbeResults_default);
	probeResultsApp.mount(host);
}
function renderProbeResults(probe) {
	const summary = $("#model-probe-results .model-probe-summary");
	const kindBadge = summary.querySelector(".model-probe-kind");
	const notesEl = summary.querySelector(".model-probe-notes");
	kindBadge.className = `model-probe-kind kind-${probe.kind}`;
	kindBadge.textContent = modelKindLabel(probe.kind);
	notesEl.textContent = probe.notes || "";
	if (!$("#model-probe-list")) return;
	probeEmptyNote.value = probe.requires_credential ? "Endpoint detected, but the model list is gated. Use the Advanced section below to add a specific model id manually." : "No models advertised — use the Advanced section to add manually.";
	const host = (() => {
		try {
			return new URL(probe.endpoint).host;
		} catch {
			return probe.endpoint;
		}
	})();
	probeRows.value = probe.models.map((modelId) => ({
		modelId,
		name: `${host} · ${modelId}`
	}));
	probeSingle.value = probe.models.length === 1;
	mountProbeResults();
	$("#model-probe-results").hidden = false;
}
async function addSelectedFromProbe() {
	if (!lastProbeResult.value || !lastProbeResult.value.kind) return;
	const checked = Array.from(document.querySelectorAll("#model-probe-list input[type=checkbox]:checked"));
	if (checked.length === 0) {
		showToast("Select at least one model.", { kind: "error" });
		return;
	}
	const items = checked.map((cb) => {
		return {
			name: (cb.closest("li").querySelector("input[type=text]")?.value || cb.value).trim(),
			kind: lastProbeResult.value.kind,
			endpoint: lastProbeResult.value.endpoint,
			model_id: cb.value
		};
	});
	const btn = $("#model-probe-add-selected");
	const original = btn.textContent;
	btn.disabled = true;
	btn.textContent = `Adding ${items.length}…`;
	try {
		const res = await authFetch("/api/models/bulk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ models: items })
		});
		const out = await res.json();
		if (!res.ok) {
			showToast("Bulk add failed: " + (out.error || res.statusText), { kind: "error" });
			return;
		}
		if (out.failed && out.failed.length > 0) {
			const lines = out.failed.map((f) => `  • ${items[f.index].model_id}: ${f.error}`).join("\n");
			showToast(`Added ${out.created_count}, ${out.failed.length} failed:\n${lines}`, { kind: "error" });
		}
		await fetchModels();
		closeModelDetail();
		await maybeAssignAfterPickerAdd((out.created || []).map((m) => m.id));
	} catch (err) {
		showToast("Bulk add failed: " + err?.message, { kind: "error" });
	} finally {
		btn.disabled = false;
		btn.textContent = original;
	}
}
async function runProbe() {
	const url = $("#model-probe-url").value.trim();
	if (!url) {
		showToast("Enter a URL or host first (e.g. localhost:11434, api.anthropic.com).", { kind: "error" });
		return;
	}
	if (/\s|[<>]/.test(url)) {
		showToast("URL contains invalid characters.", { kind: "error" });
		return;
	}
	const status = $("#model-probe-status");
	const results = $("#model-probe-results");
	status.classList.remove("error");
	status.textContent = "Probing…";
	status.hidden = false;
	results.hidden = true;
	$("#model-probe-btn").disabled = true;
	try {
		const res = await authFetch("/api/models/probe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url })
		});
		const body = await res.json();
		if (!res.ok) {
			status.textContent = body.error || `Probe failed (${res.status})`;
			status.classList.add("error");
			return;
		}
		lastProbeResult.value = body;
		if (!body.kind) {
			status.textContent = body.reason || "No known provider responded.";
			status.classList.add("error");
			return;
		}
		status.hidden = true;
		renderProbeResults(body);
	} catch (err) {
		status.textContent = "Probe failed: " + err?.message;
		status.classList.add("error");
	} finally {
		$("#model-probe-btn").disabled = false;
	}
}
//#endregion
//#region src/features/agents.ts
var deps$4 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideAgentsDeps(provided) {
	Object.assign(deps$4, provided);
}
function agentColor(name) {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i) >>> 0;
	return `hsl(${h % 360}, 60%, 55%)`;
}
async function refreshWiredAgentsForCurrentRoom() {
	const roomId = state.currentRoom;
	if (!roomId) {
		deps$4.setWiredAgentsForCurrentRoom([]);
		return;
	}
	try {
		const next = await (await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`)).json();
		if (state.currentRoom === roomId) deps$4.setWiredAgentsForCurrentRoom(next);
	} catch {}
}
function mentionAgentColor(handle) {
	const a = (deps$4.getWiredAgentsForCurrentRoom() || []).find((x) => (x.folder || "").toLowerCase() === handle);
	return a && a.name ? agentColor(a.name) : null;
}
var wireSkillState = null;
async function openWireToAgentsPicker(importBody, displayName, opts = {}) {
	if (!await deps$4.inspectAndConfirmImport(importBody, displayName, !!opts.community)) return;
	if (!state.allAgents.length) await fetchAgents();
	wireSkillState = {
		importBody,
		name: null,
		wired: /* @__PURE__ */ new Set()
	};
	deps$4.openAttachPicker({
		title: `Wire ${displayName} to agents`,
		searchPlaceholder: "Search agents…",
		emptyText: "No agents yet.",
		addNewLabel: "Wire to all agents",
		items: () => state.allAgents,
		searchText: (a) => a.name,
		name: (a) => a.name,
		isAttached: (a) => wireSkillState.wired.has(a.id),
		onToggle: async (a, add) => {
			if (add) {
				const body = await apiJson(`/api/agents/${encodeURIComponent(a.id)}/skills/import`, {
					method: "POST",
					body: importBody
				});
				wireSkillState.name = body.name;
				wireSkillState.wired.add(a.id);
				showToast(`Wired ${body.name} to ${a.name}`, { kind: "success" });
			} else {
				await apiJson(`/api/agents/${encodeURIComponent(a.id)}/skills/scoped/${encodeURIComponent(wireSkillState.name)}`, { method: "DELETE" });
				wireSkillState.wired.delete(a.id);
				showToast(`Unwired from ${a.name}`, { kind: "success" });
			}
		},
		onAddNew: async () => {
			deps$4.closeAttachPicker();
			try {
				showToast(`Added ${(await apiJson("/api/skills/import", {
					method: "POST",
					body: importBody
				})).name} to all agents`, { kind: "success" });
			} catch (err) {
				showToast("Import failed: " + (err?.message || err), { kind: "error" });
			}
		}
	});
}
function populatePermsAgentDropdowns() {
	const el = $("#perms-create-group");
	if (!el) return;
	el.innerHTML = "<option value=\"\">— global —</option>";
	permsAgents.value.forEach((a) => {
		const opt = document.createElement("option");
		opt.value = a.id;
		opt.textContent = a.name || a.id;
		el.appendChild(opt);
	});
}
async function showAgentsDetail() {
	const agents = await authFetch("/api/agents").then((r) => r.json()).catch(() => []);
	if (agents.length === 0) {
		showDetail("Agents", "<div class=\"metric-sub\">No agents</div>");
		return;
	}
	showDetail("Agents", `<table class="detail-table">
      <thead><tr><th>Name</th><th>Folder</th><th>Room</th><th>Created</th></tr></thead>
      <tbody>${[...agents].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map((b) => {
		const room = b.room_id ? `<code>${esc(b.room_id)}</code>` : "<span class=\"metric-sub\">—</span>";
		return `<tr>
      <td>${esc(b.name)}</td>
      <td><code>${esc(b.folder)}</code></td>
      <td>${room}</td>
      <td><span class="metric-sub">${esc(new Date(b.created_at).toLocaleString())}</span></td>
    </tr>`;
	}).join("")}</tbody>
    </table>`);
}
async function fetchAgents() {
	try {
		const all = await (await authFetch("/api/agents?includeArchived=1")).json();
		archivedAgentsCount.value = all.filter((a) => a.status === "archived").length;
		state.allAgents = showArchivedAgents.value ? all : all.filter((a) => a.status !== "archived");
		renderAgents();
	} catch (err) {
		console.error("Failed to fetch agents:", err);
	}
}
var agentListApp = null;
/**
* Mount the AgentList island into <ul id="agent-list">, once.
*
* Vue replaces the mount element's children, and this <ul> has no server-
* rendered content, so there is nothing to hydrate — a plain createApp is
* correct here rather than createSSRApp.
*/
function mountAgentList() {
	if (agentListApp) return;
	const host = $("#agent-list");
	if (!host) return;
	agentListApp = createApp(AgentList_default, { onPick: (id) => {
		const detail = $("#agent-detail");
		if (selectedAgentId.value === id && detail && !detail.hidden) closeAgentDetail();
		else openAgentDetail(id);
	} });
	agentListApp.mount(host);
	watchEffect(() => {
		const btn = $("#create-agent-btn");
		if (btn) btn.hidden = !isAdminView.value;
	});
}
function renderAgents() {
	mountAgentList();
	const toggle = $("#agent-show-archived");
	if (toggle) {
		toggle.hidden = archivedAgentsCount.value === 0;
		if (archivedAgentsCount.value) toggle.textContent = showArchivedAgents.value ? `Hide ${archivedAgentsCount.value} archived` : `Show ${archivedAgentsCount.value} archived`;
	}
}
function setAgentEgressControl(egress) {
	const mode = egress || "open";
	const ctl = $("#agent-egress-control");
	if (!ctl) return;
	ctl.querySelectorAll(".setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.egress === mode);
	});
	const badge = $("#agent-egress-badge");
	if (badge) badge.textContent = mode === "open" ? "" : mode === "host-only" ? "Locked down" : mode;
	const note = $("#agent-egress-note");
	if (!note) return;
	const cliOnly = mode !== "open" && mode !== "host-only";
	note.hidden = !cliOnly;
	if (cliOnly) note.textContent = `Set to "${mode}" with ncl — not changeable here`;
	ctl.querySelectorAll(".setting-option").forEach((b) => b.disabled = cliOnly);
}
function setAgentStatusControl(status) {
	const s = status || "active";
	document.querySelectorAll("#agent-status-control .setting-option").forEach((b) => {
		b.classList.toggle("active", b.dataset.status === s);
	});
}
var HARNESS_OPTIONS = [
	"claude",
	"opencode",
	"pi",
	"codex"
];
function setAgentHarnessControl(provider) {
	const p = HARNESS_OPTIONS.includes(provider) ? provider : "claude";
	document.querySelectorAll("#agent-harness-control .setting-option").forEach((b) => {
		const on = b.dataset.provider === p;
		b.classList.toggle("active", on);
		b.setAttribute("aria-pressed", String(on));
	});
}
function setAgentSubtab(name) {
	document.querySelectorAll("#agent-edit-view .agent-subtab").forEach((t) => {
		const on = t.dataset.subtab === name;
		t.classList.toggle("active", on);
		t.setAttribute("aria-selected", on ? "true" : "false");
	});
	document.querySelectorAll("#agent-edit-view .agent-subtab-panel").forEach((p) => {
		p.hidden = p.dataset.subtabPanel !== name;
	});
}
async function openAgentDetail(id) {
	const agent = state.allAgents.find((b) => b.id === id);
	if (!agent) return;
	selectedAgentId.value = id;
	renderAgents();
	deps$4.closeRoomDetail();
	deps$4.closeModelDetail();
	closeMcpDetail();
	$("#agent-edit-view").hidden = false;
	$("#agent-create-view").hidden = true;
	setAgentSubtab("settings");
	$("#agent-detail-title").textContent = agent.name ?? "";
	$("#agent-name").value = agent.name ?? "";
	if (allModels.value.length === 0) await deps$4.fetchModels();
	populateAgentModelSelect(agent.assigned_model_id);
	$("#agent-config-model").value = agent.config_model || "";
	deps$4.populateKnownModelOptions();
	setAgentStatusControl(agent.status);
	setAgentHarnessControl(agent.provider);
	setAgentEgressControl(agent.egress);
	renderAgentEnv(id);
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(id ?? "")}/instructions`);
		if (res.ok) {
			const { content, legacyBytes } = await res.json();
			$("#agent-instructions").value = content;
			const note = $("#agent-instructions-legacy");
			if (note) {
				const show = !content && legacyBytes > 0;
				note.hidden = !show;
				if (show) note.textContent = `This agent also has a ${Math.round(legacyBytes / 1024)} KB CLAUDE.local.md from before standing instructions moved here. It is not edited on this screen — run /migrate-memory to fold it in.`;
			}
		}
	} catch {}
	await loadAgentRooms(id);
	renderAgentMcp(id);
	renderAgentLearning(id);
	renderAgentSkills(id);
	renderAgentSecrets(id);
	renderAgentKeys(id);
	renderAgentSessions(id);
	captureAgentDetailBaseline();
	$("#agent-detail").hidden = false;
	$("#members-panel").hidden = true;
}
function closeAgentDetail() {
	$("#agent-detail").hidden = true;
	$("#agent-edit-view").hidden = false;
	$("#agent-create-view").hidden = true;
	selectedAgentId.value = null;
	agentDetailBaseline.value = null;
	renderAgents();
}
function agentDetailSnapshot() {
	return {
		name: $("#agent-name").value.trim(),
		model: $("#agent-model").value || "",
		configModel: $("#agent-config-model").value.trim(),
		instructions: $("#agent-instructions").value
	};
}
function captureAgentDetailBaseline() {
	agentDetailBaseline.value = agentDetailSnapshot();
	refreshAgentSaveDirty();
}
function refreshAgentSaveDirty() {
	const btn = $("#agent-save-btn");
	if (!btn || !agentDetailBaseline.value) return;
	if (btn.classList.contains("success") || btn.textContent === "Saving…") return;
	const now = agentDetailSnapshot();
	btn.disabled = now.name === agentDetailBaseline.value.name && now.model === agentDetailBaseline.value.model && now.configModel === agentDetailBaseline.value.configModel && now.instructions === agentDetailBaseline.value.instructions;
}
var canManageAgentRooms = false;
async function loadAgentRooms(agentId) {
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/rooms`);
		canManageAgentRooms = res.ok;
		agentDetailRooms.value = res.ok ? await res.json() : [];
	} catch {
		canManageAgentRooms = false;
		agentDetailRooms.value = [];
	}
	renderAgentWiredRooms();
	$("#agent-rooms-section").hidden = false;
}
var wiredRoomsApp = null;
function mountAgentWiredRooms() {
	if (wiredRoomsApp) return;
	const host = $("#agent-wired-rooms");
	if (!host) return;
	wiredRoomsApp = createApp(AgentWiredRooms_default, {
		onOpenRoom: (roomId) => deps$4.openRoomDetail(roomId),
		onRemoveRoom: (roomId, roomName) => removeRoomFromAgent(roomId, roomName)
	});
	wiredRoomsApp.mount(host);
}
function renderAgentWiredRooms() {
	const rooms = agentDetailRooms.value ?? [];
	const roomCount = $("#agent-rooms-count");
	if (roomCount) roomCount.textContent = rooms.length ? String(rooms.length) : "";
	wiredRooms.value = rooms;
	canManageRooms.value = canManageAgentRooms;
	mountAgentWiredRooms();
	$("#agent-add-room-toggle").hidden = !canManageAgentRooms;
}
async function removeRoomFromAgent(roomId, roomName) {
	if (!selectedAgentId.value) return;
	if (!await deps$4.showConfirmModal({
		title: "Remove from room",
		body: `Remove this agent from "${roomName}"? The room and its other agents are unaffected.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(selectedAgentId.value)}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to remove from room: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Removed from "${roomName}".`, { kind: "success" });
		await loadAgentRooms(selectedAgentId.value);
	} catch (err) {
		showToast("Failed to remove from room: " + err?.message, { kind: "error" });
	}
}
var sessionsApp = null;
/**
* Which agent the mounted session list belongs to. The reset callback reads it
* rather than closing over the agentId of the call that mounted the app — the
* app is created once and the detail pane is reopened for other agents, so a
* captured id would reset the wrong agent's session.
*/
var sessionsAgentId = null;
function mountAgentSessions() {
	if (sessionsApp) return;
	const host = $("#agent-sessions-list");
	if (!host) return;
	sessionsApp = createApp(AgentSessions_default, { onReset: (sessionId, el) => resetAgentSession(sessionsAgentId, sessionId, el) });
	sessionsApp.mount(host);
}
async function renderAgentSessions(agentId) {
	const countEl = $("#agent-sessions-count");
	if (!$("#agent-sessions-list")) return;
	sessionsAgentId = agentId;
	sessionsPhase.value = "loading";
	mountAgentSessions();
	let rows = [];
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/sessions`);
		if (!res.ok) throw new Error((await res.json()).error || res.status);
		rows = (await res.json()).sessions || [];
	} catch (err) {
		sessionsError.value = `Sessions unavailable: ${err?.message}`;
		sessionsPhase.value = "error";
		if (countEl) countEl.textContent = "";
		return;
	}
	if (countEl) countEl.textContent = rows.length ? String(rows.length) : "";
	sessions.value = rows;
	sessionsPhase.value = "ready";
}
async function resetAgentSession(agentId, sessionId, btn) {
	if (!await deps$4.showConfirmModal({
		title: "Reset session",
		body: "Inject /clear into this session — it drops the accumulated context and the next turn starts fresh. Useful when a session is stuck or \"autocompact is thrashing\".",
		confirmLabel: "Reset"
	})) return;
	btn.disabled = true;
	btn.textContent = "Resetting…";
	try {
		const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/reset`, { method: "POST" });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || res.status);
		showToast("Session reset — /clear queued", { kind: "success" });
		renderAgentSessions(agentId);
	} catch (err) {
		showToast("Could not reset: " + err?.message, { kind: "error" });
		btn.disabled = false;
		btn.textContent = "Reset";
	}
}
async function continueAgentImport(up) {
	const p = up.preview;
	const el = document.createElement("div");
	const line = (t, cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		d.textContent = t;
		el.appendChild(d);
	};
	line(`${p.manifest.entity.name} → imports as “${p.suggestedName}” (${p.suggestedFolder})`);
	line(p.manifest.includesConversations ? "Includes conversation history" : "Config, memory and skills only");
	const roomsOk = p.rooms.filter((r) => r.found).map((r) => r.platform_id);
	const roomsMiss = p.rooms.filter((r) => !r.found).map((r) => r.platform_id);
	if (roomsOk.length) line(`Re-links rooms: ${roomsOk.join(", ")}`);
	if (roomsMiss.length) line(`⚠ Rooms not on this install (skipped): ${roomsMiss.join(", ")}`, "import-warning");
	const mcpMiss = p.mcpServers.filter((m) => !m.found).map((m) => m.name);
	if (mcpMiss.length) line(`⚠ MCP servers to recreate: ${mcpMiss.join(", ")}`, "import-warning");
	if (!p.modelFound && p.manifest.references.model) line(`⚠ Model not found here: ${p.manifest.references.model.model_id}`, "import-warning");
	for (const c of p.manifest.requiredCredentials) line(`⚠ Needs: ${c}`, "import-warning");
	if (!await deps$4.showConfirmModal({
		title: "Import this agent?",
		body: el,
		confirmLabel: "Import"
	})) return;
	try {
		showToast(`Imported ${(await apiJson("/api/agents/import/apply", {
			method: "POST",
			body: { token: up.token }
		})).name}`, { kind: "success" });
		await fetchAgents();
		renderAgents();
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
	}
}
async function renderAgentLearning(agentId) {
	const section = $("#agent-learning-section");
	const accordion = section?.closest("details");
	if (!section) return;
	if (!state.learningMasterEnabled) {
		if (accordion) accordion.hidden = true;
		return;
	}
	let cfg = null;
	try {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`);
		if (res.ok) cfg = await res.json();
	} catch {}
	if (!cfg) {
		if (accordion) accordion.hidden = true;
		return;
	}
	if (accordion) accordion.hidden = false;
	$("#agent-learning-keep-row").hidden = !cfg.canAutoKeep;
	const paint = (groupEl, on) => {
		groupEl.querySelectorAll(".setting-option").forEach((b) => {
			b.classList.toggle("active", b.dataset.on === "1" === on);
		});
	};
	paint($("#agent-learning-distill"), cfg.autoTrigger);
	paint($("#agent-learning-keep"), cfg.autoKeep);
	const wire = (groupEl, key) => {
		groupEl.querySelectorAll(".setting-option").forEach((b) => {
			b.onclick = async () => {
				const on = b.dataset.on === "1";
				try {
					const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ [key]: on })
					});
					if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
					paint(groupEl, on);
					showToast("Learning defaults saved");
				} catch (err) {
					toastError(err, "Could not save");
				}
			};
		});
	};
	wire($("#agent-learning-distill"), "autoTrigger");
	wire($("#agent-learning-keep"), "autoKeep");
	const put = async (patch) => {
		const res = await authFetch(`/api/agents/${encodeURIComponent(agentId ?? "")}/learning`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch)
		});
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed");
	};
	const reviewSel = $("#agent-learning-review-model");
	if (reviewSel) {
		reviewSel.innerHTML = "";
		const addOpt = (value, label) => {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = label;
			reviewSel.appendChild(opt);
		};
		addOpt("", "Agent's model");
		try {
			const models = await (await authFetch("/api/models")).json();
			for (const m of models) addOpt(m.id, `${m.name} (${m.model_id})`);
		} catch {}
		for (const id of ["claude-haiku-4-5", "claude-sonnet-5"]) if (![...reviewSel.options].some((o) => o.value === id)) addOpt(id, id);
		let stored = cfg.reviewModel || "";
		if (stored && ![...reviewSel.options].some((o) => o.value === stored)) addOpt(stored, stored);
		reviewSel.value = stored;
		reviewSel.onchange = async () => {
			try {
				await put({ reviewModel: reviewSel.value || null });
				stored = reviewSel.value;
				showToast("Learning defaults saved");
			} catch (err) {
				toastError(err, "Could not save");
				reviewSel.value = stored;
			}
		};
	}
	const inputGroup = $("#agent-learning-review-input");
	if (inputGroup) {
		const paintInput = (replay) => {
			inputGroup.querySelectorAll(".setting-option").forEach((b) => {
				b.classList.toggle("active", b.dataset.value === (replay ? "replay" : "digest"));
			});
		};
		paintInput(cfg.replayReview === true);
		inputGroup.querySelectorAll(".setting-option").forEach((b) => {
			b.onclick = async () => {
				const replay = b.dataset.value === "replay";
				try {
					await put({ replayReview: replay });
					paintInput(replay);
					showToast("Learning defaults saved");
				} catch (err) {
					toastError(err, "Could not save");
				}
			};
		});
	}
}
var roomDetailEngageMode = "mention-only";
async function refreshRoomWiredAgents(roomId) {
	try {
		const [agentsRes, modeRes] = await Promise.all([authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`), authFetch(`/api/rooms/${encodeURIComponent(roomId)}/engage-mode`)]);
		roomDetailWiredAgents.value = await agentsRes.json();
		await modeRes.json().catch(() => ({}));
		roomDetailEngageMode = "mention-only";
	} catch (err) {
		console.error("Failed to fetch wired agents:", err);
		roomDetailWiredAgents.value = [];
		roomDetailEngageMode = "mention-only";
	}
	renderRoomWiredAgents();
	await populateAddAgentSelect();
	renderRoomSkills();
}
var roomWiredApp = null;
function mountRoomWiredAgents() {
	if (roomWiredApp) return;
	const host = $("#room-wired-agents");
	if (!host) return;
	roomWiredApp = createApp(RoomWiredAgents_default, {
		onPrime: (agent) => togglePrimeAgent(agent),
		onRemove: (agent) => removeAgentFromRoom(agent.id, agent.name),
		onOpen: async (agent) => {
			if (!state.allAgents.some((x) => x.id === agent.id)) await fetchAgents();
			await openAgentDetail(agent.id);
		}
	});
	roomWiredApp.mount(host);
}
function renderRoomWiredAgents() {
	const wired = roomDetailWiredAgents.value ?? [];
	roomWiredRows.value = wired;
	mountRoomWiredAgents();
	const effectiveMode = wired.some((a) => a.is_prime) ? "prime" : roomDetailEngageMode;
	const modeTip = effectiveMode === "prime" ? `Replies to everything: ${wired.find((a) => a.is_prime)?.name ?? "unknown"} — except messages that @-mention a different agent.` : "No agents reply unless @-mentioned. Star an agent to make it reply to everything.";
	const modeInfo = $("#room-mode-info");
	if (modeInfo) {
		modeInfo.hidden = false;
		modeInfo.className = `mode-info-btn mode-${effectiveMode}`;
		modeInfo.setAttribute("aria-label", `Reply mode — ${modeTip}`);
		modeInfo.onclick = (e) => {
			e.stopPropagation();
			toggleModeInfoPopup(modeInfo, modeTip);
		};
	}
}
async function togglePrimeAgent(agent) {
	if (!selectedRoomId.value) return;
	const url = `/api/rooms/${encodeURIComponent(selectedRoomId.value)}/prime`;
	try {
		const res = agent.is_prime ? await authFetch(url, { method: "DELETE" }) : await authFetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: agent.id })
		});
		if (!res.ok) {
			showToast("Could not update the default agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		await refreshRoomWiredAgents(selectedRoomId.value);
	} catch (err) {
		showToast("Could not update the default agent: " + err?.message, { kind: "error" });
	}
}
async function populateAddAgentSelect() {
	if (state.allAgents.length === 0) await fetchAgents();
	const wiredIds = new Set(roomDetailWiredAgents.value.map((a) => a.id));
	addAgentCandidates.value = state.allAgents.filter((a) => !wiredIds.has(a.id) && a.status !== "archived");
	mountAddAgentPicker();
	updateAddAgentSubmitLabel();
}
var addAgentPickerApp = null;
function mountAddAgentPicker() {
	if (addAgentPickerApp) return;
	const host = $("#room-add-agent-list");
	if (!host) return;
	addAgentPickerApp = createApp(AddAgentPicker_default, { onToggle: () => updateAddAgentSubmitLabel() });
	addAgentPickerApp.mount(host);
}
function updateAddAgentSubmitLabel() {
	const checked = $("#room-add-agent-list").querySelectorAll("input[type=checkbox]:checked");
	const btn = $("#room-add-agent-existing-submit");
	const n = checked.length;
	btn.textContent = n > 0 ? `Wire selected (${n})` : "Wire selected";
	btn.disabled = n === 0;
}
async function addExistingAgentToRoom() {
	if (!selectedRoomId.value) return;
	const checked = Array.from($("#room-add-agent-list").querySelectorAll("input[type=checkbox]:checked"));
	if (checked.length === 0) return;
	const ids = checked.map((cb) => cb.value);
	$("#room-add-agent-existing-submit").disabled = true;
	try {
		for (const id of ids) await addAgentToRoom(selectedRoomId.value, {
			kind: "existing",
			id
		});
	} finally {
		updateAddAgentSubmitLabel();
	}
}
async function addNewAgentToRoom() {
	if (!selectedRoomId.value) return;
	const name = $("#room-add-agent-new-name").value.trim();
	if (!name) return;
	const instructions = $("#room-add-agent-new-instructions").value;
	await addAgentToRoom(selectedRoomId.value, {
		kind: "new",
		name,
		instructions
	});
}
async function addAgentToRoom(roomId, ref) {
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ref)
		});
		if (!res.ok) {
			showToast("Failed to add agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		$("#room-add-agent-new-name").value = "";
		$("#room-add-agent-new-instructions").value = "";
		await fetchAgents();
		await refreshRoomWiredAgents(roomId);
	} catch (err) {
		showToast("Failed to add agent: " + err?.message, { kind: "error" });
	}
}
async function removeAgentFromRoom(agentId, agentName) {
	if (!selectedRoomId.value) return;
	if (!await deps$4.showConfirmModal({
		title: "Remove agent",
		body: `Remove "${agentName}" from this room? The agent itself will not be deleted.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		const res = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId.value)}/agents/${encodeURIComponent(agentId ?? "")}`, { method: "DELETE" });
		if (!res.ok) {
			showToast("Failed to remove agent: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		showToast(`Removed "${agentName}" from the room.`, { kind: "success" });
		await refreshRoomWiredAgents(selectedRoomId.value);
	} catch (err) {
		showToast("Failed to remove agent: " + err?.message, { kind: "error" });
	}
}
var roomCreateChecklistApp = null;
function mountRoomCreateAgentChecklist() {
	if (roomCreateChecklistApp) return;
	const host = $("#room-create-existing-agents");
	if (!host) return;
	roomCreateChecklistApp = createApp(RoomCreateAgentChecklist_default);
	roomCreateChecklistApp.mount(host);
}
function renderRoomCreateAgentChecklist() {
	createAgentAnyExist.value = state.allAgents.length > 0;
	createAgentCandidates.value = state.allAgents.filter((a) => a.status !== "archived");
	mountRoomCreateAgentChecklist();
}
function beginAgentTurn(name) {
	const turn = ensureTurn(name);
	turn.startedAt = Date.now();
	turn.lastActivityAt = turn.startedAt;
	turn.reasoningLog.length = 0;
	turn.statusLive = true;
	ensureElapsedTimer();
	updateTurnElapsed();
	return turn;
}
function endAgentTurn(name) {
	removeTurn(name || state.agentName || "Agent");
	if (turnElapsedTimer.value && !thinkingTurns.value.length) {
		clearInterval(turnElapsedTimer.value ?? void 0);
		turnElapsedTimer.value = null;
	}
}
function endAllAgentTurns() {
	for (const t of [...thinkingTurns.value]) removeTurn(t.name);
	if (turnElapsedTimer.value) {
		clearInterval(turnElapsedTimer.value ?? void 0);
		turnElapsedTimer.value = null;
	}
}
function interruptAgent(name) {
	if (!state.currentRoom || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
	state.ws.send(JSON.stringify({
		type: "interrupt",
		room_id: state.currentRoom,
		agent_name: name || null
	}));
	endAgentTurn(name);
	appendSystem(name ? `Stopped ${name}.` : "Stopped.");
}
var agentSecretsWired = false;
var agentEnvApp = null;
/** Whose env is mounted — the app is created once, the panel is reopened. */
var agentEnvGroupId = null;
function mountAgentEnv() {
	if (agentEnvApp) return;
	const host = $("#agent-env-list");
	if (!host) return;
	agentEnvApp = createApp(AgentEnvList_default, { onRemove: async (name) => {
		agentEnvDeleting.value = new Set(agentEnvDeleting.value).add(name);
		try {
			if (!(await authFetch(`/api/agents/${encodeURIComponent(agentEnvGroupId ?? "")}/env?name=${encodeURIComponent(name)}`, {
				method: "DELETE",
				headers: { "X-Webchat-CSRF": "1" }
			})).ok) throw new Error("delete failed");
			showToast(`Removed $${name} — applies when the agent restarts`);
			renderAgentEnv(agentEnvGroupId);
		} catch {
			showToast("Could not remove variable", { kind: "error" });
		} finally {
			const next = new Set(agentEnvDeleting.value);
			next.delete(name);
			agentEnvDeleting.value = next;
		}
	} });
	agentEnvApp.mount(host);
}
async function renderAgentEnv(agentGroupId) {
	if (!$("#agent-env-list")) return;
	agentEnvGroupId = agentGroupId;
	let names = [];
	try {
		const r = await authFetch(`/api/agents/${encodeURIComponent(agentGroupId ?? "")}/env`);
		if (r.ok) names = (await r.json()).names || [];
	} catch {}
	$("#agent-env-count").textContent = names.length ? String(names.length) : "";
	agentEnvNames.value = names;
	mountAgentEnv();
	const save = $("#agent-env-save");
	if (save && !save.dataset.wired) {
		save.dataset.wired = "1";
		save.addEventListener("click", async () => {
			const id = $("#agent-secrets-section").dataset.agentId;
			const name = $("#agent-env-name").value.trim();
			const value = $("#agent-env-value").value;
			if (!name || !value) {
				showToast("Name and value are required", { kind: "error" });
				return;
			}
			save.disabled = true;
			try {
				const r = await authFetch(`/api/agents/${encodeURIComponent(id ?? "")}/env`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"X-Webchat-CSRF": "1"
					},
					body: JSON.stringify({
						name,
						value
					})
				});
				if (!r.ok) {
					showToast((await r.json().catch(() => ({}))).error || "Could not add variable", { kind: "error" });
					return;
				}
				$("#agent-env-value").value = "";
				$("#agent-env-name").value = "";
				showToast(`Added $${name} — applies when the agent restarts`);
				renderAgentEnv(id);
			} finally {
				save.disabled = false;
			}
		});
	}
}
async function renderAgentSecrets(agentGroupId) {
	const section = $("#agent-secrets-section");
	if (!section) return;
	if (!agentSecretsWired) {
		agentSecretsWired = true;
		$("#agent-secret-save").addEventListener("click", () => {
			const agentGroupId = $("#agent-secrets-section").dataset.agentId;
			const personal = $("#agent-secret-personal").checked;
			saveToolSecret(personal ? {
				agentGroupId,
				userId: permsMyUserId.value
			} : agentGroupId, "#agent-secret");
		});
		wireCustomScheme("#agent-secret");
	}
	section.dataset.agentId = agentGroupId;
	let isolation = null;
	let secrets = [];
	let members = [];
	try {
		const r = await authFetch(toolSecretUrl(agentGroupId));
		if (r.ok) {
			const b = await r.json();
			isolation = b.isolation;
			secrets = b.secrets || [];
			members = b.members || [];
		}
	} catch {}
	const isolated = !!isolation?.isolated;
	$("#agent-secrets-note").textContent = !isolated && isolation?.available ? "Not private yet — secrets added here would also reach other agents" : "";
	$("#agent-secret-form").hidden = false;
	const enrolled = members.some((m) => m.userId === permsMyUserId.value);
	const personalBox = $("#agent-secret-personal");
	const personalRow = $("#agent-secret-personal-row");
	personalRow.hidden = !enrolled;
	if (!enrolled) personalBox.checked = false;
	renderAgentSecretList(agentGroupId, secrets, members);
	const total = secrets.length + members.reduce((n, m) => n + m.secrets.length, 0);
	$("#agent-secrets-count").textContent = total ? String(total) : "";
}
var agentSecretsApp = null;
/**
* The agent whose secrets are mounted. removeToolSecret needs it, and the app
* is created once while the panel is reopened for other agents — so the
* callback reads this rather than capturing the render call's argument.
*/
var agentSecretsGroupId = null;
function mountAgentSecretList() {
	if (agentSecretsApp) return;
	const host = $("#agent-secrets-list");
	if (!host) return;
	agentSecretsApp = createApp(AgentSecretList_default, { onRemove: (r) => void removeToolSecret(r.scope, r.sec, "#agent-secrets-list", agentSecretsGroupId) });
	agentSecretsApp.mount(host);
}
function renderAgentSecretList(agentGroupId, secrets, members) {
	agentSecretsGroupId = agentGroupId;
	agentSecretRows.value = [...(secrets ?? []).map((s) => ({
		key: `shared:${s.hostPattern}`,
		host: s.hostPattern,
		personal: false,
		ownerLabel: "",
		scope: agentGroupId,
		sec: s
	})), ...(members ?? []).flatMap((m) => (m.secrets ?? []).map((s) => ({
		key: `user:${m.userId}:${s.hostPattern}`,
		host: s.hostPattern,
		personal: true,
		ownerLabel: userDisplayName({ id: m.userId }),
		scope: {
			agentGroupId,
			userId: m.userId
		},
		sec: s
	})))];
	mountAgentSecretList();
}
var agentKeysWired = false;
var agentKeysApp = null;
/**
* Which agent the mounted list belongs to. The island outlives any one render,
* so its Remove handler reads this rather than capturing a render argument —
* the same reason agentSecretsGroupId exists.
*/
var agentKeysGroupId = null;
function mountAgentKeyList() {
	if (agentKeysApp) return;
	const host = $("#agent-keys-list");
	if (!host) return;
	agentKeysApp = createApp(AgentKeyList_default, {
		onCopy: async (r) => {
			try {
				await navigator.clipboard.writeText(r.publicKey);
				showToast("Public key copied");
			} catch {
				showToast("Could not copy", { kind: "error" });
			}
		},
		onRemove: (r) => void removeAgentKey(agentKeysGroupId, r.key)
	});
	agentKeysApp.mount(host);
}
async function renderAgentKeys(agentGroupId) {
	const section = $("#agent-keys-section");
	if (!section) return;
	if (!agentKeysWired) {
		agentKeysWired = true;
		$("#agent-key-create").addEventListener("click", () => void createAgentKey());
	}
	section.dataset.agentId = agentGroupId;
	let keys = [];
	try {
		const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}`);
		if (r.ok) keys = (await r.json()).keys || [];
	} catch {}
	agentKeysGroupId = agentGroupId;
	agentKeyRows.value = keys.map((k) => ({
		name: k.name,
		meta: k.target ? `ssh -i ${k.path} ${k.target}` : `${k.path} · no login target set`,
		publicKey: k.publicKey,
		key: k
	}));
	mountAgentKeyList();
	$("#agent-keys-count").textContent = keys.length ? String(keys.length) : "";
}
async function createAgentKey() {
	const agentGroupId = $("#agent-keys-section").dataset.agentId;
	const name = $("#agent-key-name").value.trim().toLowerCase();
	$("#agent-key-target").value.trim();
	if (!name) {
		showToast("Name is required", { kind: "error" });
		return;
	}
	const btn = $("#agent-key-create");
	btn.disabled = true;
	try {
		const r = await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ name })
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) {
			showToast(body.error || "Could not create key", { kind: "error" });
			return;
		}
		$("#agent-key-name").value = "";
		$("#agent-key-target").value = "";
		try {
			await navigator.clipboard.writeText(body.key.publicKey);
			showToast(`Created ${name} — public key copied`);
		} catch {
			showToast(`Created ${name}`);
		}
		await renderAgentKeys(agentGroupId);
	} catch {
		showToast("Could not create key", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
async function removeAgentKey(agentGroupId, key) {
	if (!await deps$4.showConfirmModal({
		title: "Remove deploy key",
		body: `Delete “${key.name}”? Anything using it to authenticate will stop working.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	if (!(await authFetch(`/api/deploy-keys?agentGroupId=${encodeURIComponent(agentGroupId ?? "")}&name=${encodeURIComponent(key.name)}`, {
		method: "DELETE",
		headers: { "X-Webchat-CSRF": "1" }
	})).ok) {
		showToast("Could not remove key", { kind: "error" });
		return;
	}
	showToast(`Removed ${key.name}`);
	await renderAgentKeys(agentGroupId);
}
function populateAgentModelSelect(currentModelId) {
	$("#agent-model").value = currentModelId || "";
	refreshAgentModelTrigger();
}
function refreshAgentModelTrigger() {
	const trigger = $("#agent-model-trigger");
	if (!trigger) return;
	const id = $("#agent-model").value;
	const nameEl = trigger.querySelector(".model-picker-trigger-name");
	const metaEl = trigger.querySelector(".model-picker-trigger-meta");
	if (!id) {
		nameEl.textContent = "Default";
		const derived = state.allAgents.find((a) => a.id === selectedAgentId.value)?.effective_model_label;
		metaEl.textContent = derived ? `${derived} · auto-detected` : "Built-in Anthropic";
		return;
	}
	const m = allModels.value.find((mm) => mm.id === id);
	if (!m) {
		nameEl.textContent = "Unknown model";
		metaEl.textContent = id;
		return;
	}
	nameEl.textContent = m.name ?? "";
	const host = endpointHost(m.endpoint);
	metaEl.textContent = host ? `${deps$4.modelKindLabel(m.kind)} · ${m.model_id} · ${host}` : `${deps$4.modelKindLabel(m.kind)} · ${m.model_id}`;
}
var AGENT_STATUS_HINTS = {
	active: "Responds normally and appears everywhere.",
	paused: "Wiring is kept, but the agent never responds. Still listed.",
	archived: "Retired: never responds and hidden from lists, pickers, and the map."
};
function wireAgentsPanel() {
	$("#agent-harness-control")?.addEventListener("click", async (e) => {
		const btn = e.target?.closest(".setting-option");
		if (!btn || !selectedAgentId.value) return;
		const provider = btn.dataset.provider;
		const agent = state.allAgents.find((a) => a.id === selectedAgentId.value);
		if (!agent || (agent.provider || "claude") === provider) return;
		setAgentHarnessControl(provider);
		try {
			const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/provider`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
			showToast(`Harness → ${provider === "opencode" ? "OpenCode" : "Claude"} — restarting the agent…`, { kind: "success" });
			await fetchAgents();
		} catch (err) {
			setAgentHarnessControl(agent.provider);
			toastError(err, "Could not change harness");
		}
	});
	document.querySelectorAll("#agent-edit-view .agent-subtab").forEach((tab) => {
		tab.addEventListener("click", () => setAgentSubtab(tab.dataset.subtab));
	});
	$("#agent-detail-close")?.addEventListener("click", closeAgentDetail);
	$("#agent-create-close")?.addEventListener("click", closeAgentDetail);
	$("#agent-name")?.addEventListener("input", refreshAgentSaveDirty);
	$("#agent-instructions")?.addEventListener("input", refreshAgentSaveDirty);
	$("#agent-config-model")?.addEventListener("input", refreshAgentSaveDirty);
	$("#agent-status-control")?.addEventListener("click", async (e) => {
		const btn = e.target?.closest(".setting-option");
		if (!btn || !selectedAgentId.value) return;
		const status = btn.dataset.status;
		if (!status) return;
		const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
		if (agent && (agent.status || "active") === status) return;
		setAgentStatusControl(status);
		try {
			const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/status`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status })
			});
			if (!res.ok) throw new Error("status " + res.status);
			if (agent) agent.status = status;
			showToast(`${status[0].toUpperCase()}${status.slice(1)} — ${AGENT_STATUS_HINTS[status] || ""}`);
			renderAgents();
		} catch (err) {
			console.error("Failed to set agent status:", err);
			showToast("Could not change status", { kind: "error" });
			if (agent) setAgentStatusControl(agent.status);
		}
	});
	$("#agent-egress-control")?.addEventListener("click", async (e) => {
		const btn = e.target?.closest(".setting-option");
		if (!btn || btn.disabled || !selectedAgentId.value) return;
		const egress = btn.dataset.egress;
		const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
		const current = agent && agent.egress || "open";
		if (current === egress) return;
		if (egress === "host-only") {
			if (!await showConfirmModal({
				title: "Lock down this agent?",
				body: "It will only reach the network through the credential gateway. Anything it does over HTTPS keeps working. Direct connections stop — SSH and rsync, services on your LAN, and a model server running on this host. Applies the next time the agent starts.",
				confirmLabel: "Lock down",
				destructive: true
			})) return;
		}
		setAgentEgressControl(egress);
		try {
			const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/egress`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify({ egress })
			});
			if (!res.ok) throw new Error("status " + res.status);
			if (agent) agent.egress = egress;
			showToast(egress === "host-only" ? "Locked down — applies when the agent restarts" : "Open network");
		} catch (err) {
			console.error("Failed to set agent egress:", err);
			showToast("Could not change network mode", { kind: "error" });
			setAgentEgressControl(current);
		}
	});
	$("#agent-show-archived")?.addEventListener("click", async () => {
		showArchivedAgents.value = !showArchivedAgents.value;
		await fetchAgents();
	});
	$("#agent-add-room-toggle")?.addEventListener("click", async () => {
		const agentId = selectedAgentId.value;
		if (!agentId) return;
		let allRooms = [];
		try {
			const res = await authFetch("/api/rooms");
			allRooms = res.ok ? await res.json() : [];
		} catch {}
		deps$4.openAttachPicker({
			title: "Rooms",
			searchPlaceholder: "Search rooms…",
			emptyText: "No rooms yet.",
			items: () => allRooms,
			searchText: (r) => r.name || r.id,
			name: (r) => r.name || r.id,
			isAttached: (r) => agentDetailRooms.value.some((x) => x.id === r.id),
			onToggle: async (r, add) => {
				const res = add ? await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						kind: "existing",
						id: agentId
					})
				}) : await authFetch(`/api/rooms/${encodeURIComponent(r.id)}/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
				if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
				showToast(add ? `Wired to ${r.name || r.id}` : `Unwired from ${r.name || r.id}`, { kind: "success" });
				await loadAgentRooms(agentId);
			}
		});
	});
}
function wireAgentDetail1() {
	$("#agent-detail-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!selectedAgentId.value) return;
		const btn = $("#agent-save-btn");
		if (!btn) return;
		const originalLabel = btn.textContent;
		btn.disabled = true;
		btn.textContent = "Saving…";
		btn.classList.remove("success");
		const updates = { name: ($("#agent-name")?.value ?? "").trim() };
		try {
			await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(updates)
			});
			await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/instructions`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: $("#agent-instructions")?.value ?? "" })
			});
			const selectedModel = ($("#agent-model")?.value ?? "") || null;
			if (selectedModel !== (state.allAgents.find((b) => b.id === selectedAgentId.value)?.assigned_model_id || null)) {
				const mRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/model`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ modelId: selectedModel })
				});
				try {
					if (mRes.ok) deps$4.warnIfUnreachable((await mRes.json()).reachability);
				} catch {}
			}
			const configModel = ($("#agent-config-model")?.value ?? "").trim();
			const currentConfigModel = state.allAgents.find((b) => b.id === selectedAgentId.value)?.config_model || "";
			if (configModel !== currentConfigModel) {
				const cRes = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}/config-model`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: configModel })
				});
				if (!cRes.ok) {
					let detail = `HTTP ${cRes.status}`;
					try {
						detail = (await cRes.json()).error || detail;
					} catch {}
					const cfgModel = $("#agent-config-model");
					if (cfgModel) cfgModel.value = currentConfigModel;
					throw new Error(detail);
				}
			}
			await fetchAgents();
			agentDetailBaseline.value = agentDetailSnapshot();
			btn.textContent = "✓ Saved";
			btn.classList.add("success");
			setTimeout(() => {
				if (btn.isConnected) {
					btn.textContent = originalLabel;
					btn.classList.remove("success");
					refreshAgentSaveDirty();
				}
			}, 1500);
		} catch (err) {
			console.error("Failed to update agent:", err);
			showToast("Failed to save agent: " + (err.message || "Unknown error"), { kind: "error" });
			btn.textContent = originalLabel;
			btn.classList.remove("success");
			btn.disabled = false;
		}
	});
}
function wireAgentDetail2() {
	$("#room-add-agent-existing-submit")?.addEventListener("click", addExistingAgentToRoom);
}
function wireAgentDetail3() {
	$("#agent-model-trigger")?.addEventListener("click", () => {
		if (selectedAgentId.value) openModelPicker();
	});
}
function wireAgentControls1() {
	$("#agent-export-btn")?.addEventListener("click", async () => {
		if (!selectedAgentId.value) return;
		const { ok, checked } = await confirmWithToggle({
			title: "Export this agent?",
			toggleLabel: "Include conversations (larger; briefly stops this agent)",
			note: "Credentials never export — the bundle lists what to reconnect on import.",
			confirmLabel: "Export"
		});
		if (!ok) return;
		const a = document.createElement("a");
		a.href = `/api/agents/${encodeURIComponent(selectedAgentId.value)}/export${checked ? "?conversations=1" : ""}`;
		a.download = "";
		document.body.appendChild(a);
		a.click();
		a.remove();
		showToast("Export started — check your downloads", { kind: "success" });
	});
}
function wireAgentControls2() {
	$("#import-agent-btn")?.addEventListener("click", () => $("#import-agent-file")?.click());
	$("#import-agent-file")?.addEventListener("change", async (e) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		showToast("Uploading bundle…", { kind: "info" });
		let up;
		try {
			const fd = new FormData();
			fd.append("bundle", file);
			const res = await authFetch("/api/agents/import", {
				method: "POST",
				body: fd
			});
			up = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(up.error || res.statusText);
		} catch (err) {
			showToast("Import failed: " + (err?.message || err), { kind: "error" });
			return;
		}
		return continueAgentImport(up);
	});
}
function wireAgentControls3() {
	$("#agent-mcp-attach-toggle")?.addEventListener("click", async () => {
		const agentId = selectedAgentId.value;
		if (!agentId) return;
		await fetchMcpServers();
		openAttachPicker({
			title: "MCP servers",
			searchPlaceholder: "Search servers…",
			emptyText: "No servers yet — use “+ Add new server”.",
			addNewLabel: "+ Add new server",
			items: () => allMcpServers.value,
			searchText: (s) => `${s.name} ${s.transport} ${s.target}`,
			name: (s) => s.name,
			meta: (s) => `${s.transport} · ${s.target}`,
			isAttached: (s) => agentMcpServers.value.some((a) => a.id === s.id),
			onToggle: (s, add) => setAgentMcp(agentId, add ? { add: [s.id] } : { remove: [s.id] }, add ? `Attached ${s.name}` : `Detached ${s.name}`),
			onAddNew: () => {
				mcpAddInProgress.value = true;
				mcpAgentForAdd.value = agentId;
				closeAttachPicker();
				setTimeout(() => $("#create-mcp-btn")?.click(), 180);
			}
		});
	});
}
function wireAgentControls4() {
	$("#agent-delete")?.addEventListener("click", async () => {
		if (!selectedAgentId.value) return;
		const agent = state.allAgents.find((b) => b.id === selectedAgentId.value);
		if (!await showConfirmModal({
			title: "Delete agent",
			body: `Delete "${agent?.name}"? This removes the agent, its workspace, and all session history. This cannot be undone.`,
			confirmLabel: "Delete",
			destructive: true
		})) return;
		try {
			const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId.value)}`, { method: "DELETE" });
			if (!res.ok) {
				showToast(`Failed to delete agent: ${(await res.json().catch(() => ({}))).error || res.statusText}`, { kind: "error" });
				return;
			}
			showToast(`Deleted "${agent?.name}".`, { kind: "success" });
			closeAgentDetail();
			await fetchAgents();
		} catch (err) {
			showToast(`Failed to delete agent: ${err.message}`, { kind: "error" });
		}
	});
}
function wireAgentControls5() {
	$("#room-add-agent-new-submit")?.addEventListener("click", addNewAgentToRoom);
	document.querySelectorAll(".room-agent-picker-tab").forEach((tab) => {
		tab.addEventListener("click", () => {
			document.querySelectorAll(".room-agent-picker-tab").forEach((t) => t.classList.remove("active"));
			tab.classList.add("active");
			const which = tab.dataset.picker;
			const existing = $("#room-add-agent-existing");
			const fresh = $("#room-add-agent-new");
			if (existing) existing.hidden = which !== "existing";
			if (fresh) fresh.hidden = which !== "new";
		});
	});
}
function wireAgentCreate1() {
	$("#create-agent-btn")?.addEventListener("click", () => {
		selectedAgentId.value = null;
		renderAgents();
		const el1 = $("#agent-edit-view");
		if (el1) el1.hidden = true;
		const el2 = $("#agent-create-view");
		if (el2) el2.hidden = false;
		const _el1 = $("#agent-create-name");
		if (_el1) _el1.value = "";
		const el3 = $("#agent-detail");
		if (el3) el3.hidden = false;
		const el4 = $("#members-panel");
		if (el4) el4.hidden = true;
		$("#agent-create-name")?.focus();
	});
}
function wireAgentCreate2() {
	$("#create-mcp-btn")?.addEventListener("click", () => {
		selectedMcpId.value = null;
		renderMcpServers();
		closeAgentDetail();
		closeRoomDetail();
		closeModelDetail();
		closeMcpDetail();
		const el5 = $("#mcp-edit-view");
		if (el5) el5.hidden = true;
		const el6 = $("#mcp-create-view");
		if (el6) el6.hidden = false;
		const _el2 = $("#mcp-probe-url");
		if (_el2) _el2.value = "";
		const el7 = $("#mcp-probe-status");
		if (el7) el7.hidden = true;
		const el8 = $("#mcp-probe-results");
		if (el8) el8.hidden = true;
		const _el3 = $("#mcp-probe-name");
		if (_el3) _el3.value = "";
		const _el4 = $("#mcp-probe-token");
		if (_el4) _el4.value = "";
		const h1 = $("#mcp-probe-token-label");
		if (h1) h1.hidden = true;
		lastMcpProbe.value = null;
		lastMcpProbeToken.value = "";
		const _el5 = $("#mcp-create-name");
		if (_el5) _el5.value = "";
		const _el6 = $("#mcp-create-url");
		if (_el6) _el6.value = "";
		const _el7 = $("#mcp-create-command");
		if (_el7) _el7.value = "";
		const _el8 = $("#mcp-create-args");
		if (_el8) _el8.value = "";
		const _el9 = $("#mcp-create-token");
		if (_el9) _el9.value = "";
		const _el10 = $("#mcp-create-transport");
		if (_el10) _el10.value = "sse";
		syncMcpCreateTransportFields();
		const el9 = $("#mcp-detail");
		if (el9) el9.hidden = false;
		const el10 = $("#members-panel");
		if (el10) el10.hidden = true;
	});
}
function toggleModeInfoPopup(anchor, text) {
	const wrap = anchor.closest(".form-label-row");
	const existing = wrap.querySelector(".mode-info-popup");
	if (existing) {
		existing.remove();
		return;
	}
	const pop = document.createElement("div");
	pop.className = "mode-info-popup";
	pop.setAttribute("role", "tooltip");
	pop.textContent = text;
	wrap.appendChild(pop);
	const close = (e) => {
		if (e && (pop.contains(e.target) || anchor.contains(e.target))) return;
		pop.remove();
		document.removeEventListener("click", close);
		document.removeEventListener("keydown", onKey);
	};
	const onKey = (e) => {
		if (e.key === "Escape") close();
	};
	setTimeout(() => {
		document.addEventListener("click", close);
		document.addEventListener("keydown", onKey);
	}, 0);
}
/**
* Reveal the header/template fields only when the operator opts into stating
* them. Wired once per form; the rows stay in the DOM so values survive a
* toggle away and back, and are cleared on a successful save with the rest.
*/
function wireCustomScheme(p) {
	const box = $(`${p}-custom`);
	if (!box || box.dataset.wired) return;
	box.dataset.wired = "1";
	const sync = () => {
		$(`${p}-custom-header-row`).hidden = !box.checked;
		$(`${p}-custom-format-row`).hidden = !box.checked;
	};
	box.addEventListener("change", sync);
	sync();
}
function endpointHost(endpoint) {
	if (!endpoint) return "";
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}
function showDetail(title, html) {
	$("#dash-detail-title").textContent = title;
	$("#dash-detail-body").innerHTML = html;
	$("#dash-detail").hidden = false;
	$("#dash-detail").scrollIntoView({
		behavior: "smooth",
		block: "nearest"
	});
}
/**
* Scope → query string. `null` = system-wide, a string = that agent,
* `{agentGroupId,userId}` = that one person's credential.
*/
function toolSecretUrl(scope, extra = "") {
	if (scope && typeof scope === "object") return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope.agentGroupId)}&userId=${encodeURIComponent(scope.userId)}${extra}`;
	return `/api/tool-secrets?agentGroupId=${encodeURIComponent(scope ?? "*")}${extra}`;
}
var TURN_QUIET_MS = 5e3;
function markTurnActivity(name) {
	const turn = turnFor(name);
	if (turn) turn.lastActivityAt = Date.now();
}
function updateTurnElapsed() {
	for (const t of thinkingTurns.value) {
		const secs = Math.floor((Date.now() - t.startedAt) / 1e3);
		if (secs < 2) {
			t.elapsed = "";
			continue;
		}
		t.elapsed = Date.now() - t.lastActivityAt > TURN_QUIET_MS ? ` · still working ${secs}s` : ` · ${secs}s`;
	}
	if (!thinkingTurns.value.length && turnElapsedTimer.value) {
		clearInterval(turnElapsedTimer.value);
		turnElapsedTimer.value = null;
	}
}
function ensureElapsedTimer() {
	if (!turnElapsedTimer.value) turnElapsedTimer.value = setInterval(updateTurnElapsed, 1e3);
}
var secretsWired = false;
async function renderToolSecrets() {
	const section = $("#settings-secrets");
	if (!section) return;
	section.hidden = !state.isOwnerView;
	if (!state.isOwnerView) return;
	if (!secretsWired) {
		secretsWired = true;
		$("#secret-save").addEventListener("click", () => void saveToolSecret());
		wireCustomScheme("#secret");
	}
	await loadToolSecretList();
}
var toolSecretsApp = null;
/** The scope the mounted list belongs to — the remove callback reads it. */
var toolSecretsScope = null;
function mountToolSecrets() {
	if (toolSecretsApp) return;
	const host = $("#secrets-list");
	if (!host) return;
	toolSecretsApp = createApp(ToolSecretList_default, { onRemove: (secret) => void removeToolSecret(toolSecretsScope, secret, "#secrets-list") });
	toolSecretsApp.mount(host);
}
async function loadToolSecretList(scope = null, listSel = "#secrets-list") {
	if (listSel !== "#secrets-list" || !$("#secrets-list")) return;
	toolSecretsScope = scope;
	let secrets = [];
	try {
		const r = await authFetch(toolSecretUrl(scope));
		if (r.ok) secrets = (await r.json()).secrets || [];
	} catch {
		secrets = [];
	}
	toolSecretRows.value = secrets;
	mountToolSecrets();
}
async function saveToolSecret(scope = null, p = "#secret") {
	const hostPattern = $(`${p}-host`).value.trim();
	const value = $(`${p}-value`).value;
	if (!hostPattern || !value) {
		showToast("Host and value are required", { kind: "error" });
		return;
	}
	let scheme;
	if ($(`${p}-custom`)?.checked) {
		const headerName = $(`${p}-custom-header`)?.value.trim() || "";
		const valueFormat = $(`${p}-custom-format`)?.value.trim() || "";
		if (!headerName || !valueFormat) {
			showToast("A custom header needs both a name and a value template", { kind: "error" });
			return;
		}
		scheme = {
			headerName,
			valueFormat
		};
	}
	const btn = $(`${p}-save`);
	btn.disabled = true;
	try {
		const r = await authFetch(toolSecretUrl(scope), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(scheme ? {
				value,
				hostPattern,
				scheme
			} : {
				value,
				hostPattern
			})
		});
		if (!r.ok) {
			showToast((await r.json().catch(() => ({}))).error || "Could not add secret", { kind: "error" });
			return;
		}
		$(`${p}-value`).value = "";
		$(`${p}-host`).value = "";
		if ($(`${p}-custom-header`)) $(`${p}-custom-header`).value = "";
		if ($(`${p}-custom-format`)) $(`${p}-custom-format`).value = "";
		showToast(`Added ${hostPattern}`);
		if (scope) await renderAgentSecrets(typeof scope === "object" ? scope.agentGroupId : scope);
		else await loadToolSecretList(null, "#secrets-list");
	} catch {
		showToast("Could not add secret", { kind: "error" });
	} finally {
		btn.disabled = false;
	}
}
async function removeToolSecret(scope, secret, listSel = "#secrets-list", agentGroupId = null) {
	if (!await showConfirmModal({
		title: "Remove secret",
		body: `Delete the credential for ${secret.hostPattern}? Requests that rely on it will start failing.`,
		confirmLabel: "Remove",
		destructive: true
	})) return;
	try {
		if (!(await authFetch(toolSecretUrl(scope, `&id=${encodeURIComponent(secret.id)}`), {
			method: "DELETE",
			headers: { "X-Webchat-CSRF": "1" }
		})).ok) {
			showToast("Could not remove secret", { kind: "error" });
			return;
		}
		showToast(`Removed ${secret.label}`);
		if (agentGroupId) await renderAgentSecrets(agentGroupId);
		else if (listSel) await loadToolSecretList(scope, listSel);
	} catch {
		showToast("Could not remove secret", { kind: "error" });
	}
}
//#endregion
//#region src/features/my-credentials-state.ts
/** One group per agent the user has personal credentials for. */
var myCredGroups = ref([]);
/** Agent group ids whose add-form request is in flight. */
var myCredSaving = ref(/* @__PURE__ */ new Set());
//#endregion
//#region src/features/preflight-state.ts
/** 'running' | 'message' | 'checks' — the three things this element ever shows. */
var preflightPhase = ref("running");
/** Text for the running/error/empty states. */
var preflightMessage = ref("");
/** One row per check, already shaped. */
var preflightChecks = ref([]);
//#endregion
//#region src/features/prejudge-state.ts
/** One row per action: opted-in state and whether it is never-auto-approvable. */
var prejudgeRows = ref([]);
/**
* Judge-model options, already filtered to what the PUT accepts and labelled.
*
* "Off" is not in here — it is a fixed first option, not a model.
*/
var prejudgeModelOptions = ref([]);
//#endregion
//#region src/features/PrejudgeActions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$5 = [
	"data-action",
	"checked",
	"disabled",
	"onChange"
];
var NEVER_TITLE = "Always needs a human";
//#endregion
//#region src/features/PrejudgeActions.vue
var PrejudgeActions_default = /* @__PURE__ */ defineComponent({
	__name: "PrejudgeActions",
	props: { onToggle: { type: Function } },
	setup(__props) {
		/**
		* Which approval actions may be pre-judged — fifty-sixth island.
		*
		* Mounted into <div id="prejudge-actions-list">, exclusively owned by this
		* module. The #prejudge-actions-group hidden flag stays imperative: the whole
		* group disappears when no judge model is configured, which is a decision about
		* the feature rather than the rows.
		*
		* NEVER-list rows are rendered disabled AND unchecked, and that pairing is
		* load-bearing: the save reads `input:not(:disabled):checked`, so a disabled row
		* can never contribute to the saved list even if something ticked it. Their
		* label carries the reason on hover — always needs a human.
		*
		* The ticks stay in the DOM because that save reads them with querySelectorAll.
		* Same contract as the agent pickers and the probe list.
		*/
		const props = __props;
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(prejudgeRows), (r) => {
				return openBlock(), createElementBlock("label", mergeProps({
					key: r.action,
					class: r.never ? "setting-toggle prejudge-never" : "setting-toggle"
				}, { ref_for: true }, r.never ? { title: NEVER_TITLE } : {}), [createElementVNode("span", null, toDisplayString(r.action), 1), createElementVNode("input", {
					type: "checkbox",
					"data-action": r.action,
					checked: r.checked,
					disabled: r.never || void 0,
					onChange: ($event) => r.never ? void 0 : props.onToggle($event.target)
				}, null, 40, _hoisted_1$5)], 16);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/MyCredentials.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$4 = { class: "form-label" };
var _hoisted_2$3 = { class: "skill-sources-list" };
var _hoisted_3$3 = { class: "skill-info" };
var _hoisted_4$1 = { class: "skill-head" };
var _hoisted_5 = ["onClick"];
var _hoisted_6 = { class: "secret-form" };
var _hoisted_7 = ["disabled", "onClick"];
var ADD = "Add secret";
var REMOVE = "Remove";
var HOST_LABEL = "Host";
var VALUE_LABEL = "Token or key";
var HOST_PLACEHOLDER = "dev.azure.com";
//#endregion
//#region src/features/MyCredentials.vue
var MyCredentials_default = /* @__PURE__ */ defineComponent({
	__name: "MyCredentials",
	props: {
		onRemove: { type: Function },
		onAdd: { type: Function }
	},
	setup(__props) {
		/**
		* The user's own per-agent credentials — fifty-eighth island.
		*
		* Mounted into <div id="my-credentials-list">, exclusively owned by this module.
		* #settings-my-credentials keeps its hidden flag: with no connected credentials
		* anywhere the whole section disappears rather than explaining itself.
		*
		* ONE add-form per agent, not a shared form with an agent picker — that would
		* just be the "Used by" dropdown again, and this list is short by construction.
		*
		* The two fields are UNCONTROLLED and read at click time, exactly as the
		* imperative version read hostField.input.value. v-model would have been the
		* obvious Vue idiom and is wrong here: it attaches an input listener to every
		* field, which the original never had and which the listener-set guard counts.
		*
		* fieldEl() is absorbed; it was used only here. The password field keeps
		* autocomplete="new-password" — so browsers do not offer the user's saved
		* login for a token box — and spellcheck off.
		*/
		const props = __props;
		function add(g, e) {
			const [host, value] = [...e.currentTarget.closest(".secret-form").querySelectorAll("input")];
			props.onAdd(g, host.value.trim(), value.value, [host, value]);
		}
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(unref(myCredGroups), (g) => {
				return openBlock(), createElementBlock("div", {
					key: g.agentGroupId,
					class: "my-cred-group"
				}, [
					createElementVNode("span", _hoisted_1$4, toDisplayString(g.name), 1),
					createElementVNode("ul", _hoisted_2$3, [(openBlock(true), createElementBlock(Fragment, null, renderList(g.secrets, (sec, i) => {
						return openBlock(), createElementBlock("li", {
							key: i,
							class: "skill-source-row secret-row"
						}, [createElementVNode("div", _hoisted_3$3, [createElementVNode("div", _hoisted_4$1, toDisplayString(sec.hostPattern), 1)]), createElementVNode("button", {
							class: "btn btn-danger",
							type: "button",
							onClick: ($event) => props.onRemove(g, sec)
						}, toDisplayString(REMOVE), 8, _hoisted_5)]);
					}), 128))]),
					createElementVNode("div", _hoisted_6, [
						createElementVNode("label", { class: "secret-field" }, [createElementVNode("span", { class: "form-label" }, toDisplayString(HOST_LABEL)), createElementVNode("input", {
							type: "text",
							placeholder: HOST_PLACEHOLDER,
							autocomplete: "off",
							spellcheck: "false"
						})]),
						createElementVNode("label", { class: "secret-field" }, [createElementVNode("span", { class: "form-label" }, toDisplayString(VALUE_LABEL)), _cache[0] || (_cache[0] = createElementVNode("input", {
							type: "password",
							autocomplete: "new-password",
							spellcheck: "false"
						}, null, -1))]),
						createElementVNode("button", {
							class: "btn btn-primary",
							type: "button",
							disabled: unref(myCredSaving).has(g.agentGroupId) || void 0,
							onClick: ($event) => add(g, $event)
						}, toDisplayString(ADD), 8, _hoisted_7)
					])
				]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/Preflight.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$3 = { class: "preflight-check-head" };
var _hoisted_2$2 = { class: "preflight-fix" };
var _hoisted_3$2 = ["onClick"];
var COPY = "Copy fix";
var COPIED = "Copied";
//#endregion
//#region src/features/Preflight.vue
var Preflight_default = /* @__PURE__ */ defineComponent({
	__name: "Preflight",
	props: { onCopy: { type: Function } },
	setup(__props) {
		/**
		* The webchat self-test results — fifty-ninth island.
		*
		* Mounted into <div id="selftest-results">, exclusively owned by this module.
		* Its hidden flag stays imperative — it is revealed when the run starts.
		*
		* The element previously held three different things written three different
		* ways: a plain textContent wait line, a plain textContent error, and built
		* check rows. Converting only the rows would have left two imperative writers
		* on a Vue-owned element, so the messages are phases too.
		*
		* The fix block is a copy-paste command — same shape as the reachability
		* verdict, deliberately not shared with it: the classes differ (preflight-fix
		* vs model-reachability-fix) and a shared component would need a prop to choose
		* them, which is a worse seam than eight duplicated lines.
		*/
		const props = __props;
		const copied = ref("");
		let timer = null;
		async function copy(fix) {
			if (!await props.onCopy(fix)) return;
			copied.value = fix;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => copied.value = "", 1500);
		}
		return (_ctx, _cache) => {
			return unref(preflightPhase) !== "checks" ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createTextVNode(toDisplayString(unref(preflightMessage)), 1)], 64)) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(unref(preflightChecks), (c, i) => {
				return openBlock(), createElementBlock("div", {
					key: i,
					class: normalizeClass(`preflight-check status-${c.status}`)
				}, [createElementVNode("div", _hoisted_1$3, toDisplayString(c.head), 1), c.fix ? (openBlock(), createElementBlock(Fragment, { key: 0 }, [createElementVNode("pre", _hoisted_2$2, toDisplayString(c.fix), 1), createElementVNode("button", {
					type: "button",
					class: "btn btn-ghost",
					onClick: ($event) => copy(c.fix)
				}, toDisplayString(copied.value === c.fix ? COPIED : COPY), 9, _hoisted_3$2)], 64)) : createCommentVNode("", true)], 2);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/PrejudgeModelOptions.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$2 = ["value"];
var OFF = "Off";
//#endregion
//#region src/features/PrejudgeModelOptions.vue
var PrejudgeModelOptions_default = /* @__PURE__ */ defineComponent({
	__name: "PrejudgeModelOptions",
	setup(__props) {
		/**
		* The approval pre-judge's judge-model options — sixty-third island.
		*
		* Mounted into <select id="prejudge-model-select">, exclusively owned by this
		* module. Everything else renderPrejudgeSettings does — hiding the section,
		* fetching the config, assigning the select's value and its onchange — is state
		* applied to static markup and stays imperative.
		*
		* "Off" is rendered HERE rather than left in index.html. It is in the static
		* markup, but the imperative version cleared the select and rebuilt Off as the
		* first option every time; Vue replaces the host's children on mount, so the
		* static one would be wiped and never come back. Reproducing it is what keeps
		* the two agreeing.
		*
		* Only models the PUT accepts are listed — anthropic kind (OneCLI-proxied), or
		* a local kind with an endpoint. That filter stays in the renderer: it is a
		* fact about the API contract, not about this markup.
		*
		* The select's own `value` is assigned by the renderer AFTER awaiting nextTick.
		* Options now appear a tick later than the assignment that selects one, which
		* they did not when both were synchronous — assigning first would silently
		* select nothing and read back as "the stored judge left the roster".
		*/
		return (_ctx, _cache) => {
			return openBlock(), createElementBlock(Fragment, null, [createElementVNode("option", { value: "" }, toDisplayString(OFF)), (openBlock(true), createElementBlock(Fragment, null, renderList(unref(prejudgeModelOptions), (m) => {
				return openBlock(), createElementBlock("option", {
					key: m.id,
					value: m.id
				}, toDisplayString(m.label), 9, _hoisted_1$2);
			}), 128))], 64);
		};
	}
});
//#endregion
//#region src/features/settings.ts
var deps$3 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideSettingsDeps(provided) {
	Object.assign(deps$3, provided);
}
var DEFAULTS = {
	theme: "dark",
	font: "medium",
	sendKey: "enter",
	notifications: true
};
function loadSettings() {
	try {
		const raw = JSON.parse(localStorage.getItem("nanoclaw-settings") || "{}");
		delete raw.readAloud;
		delete raw.readAloudRooms;
		delete raw.readAloudDefault;
		return {
			...DEFAULTS,
			...raw
		};
	} catch {
		return { ...DEFAULTS };
	}
}
function saveSettings(settings) {
	localStorage.setItem("nanoclaw-settings", JSON.stringify(settings));
}
function applySettings() {
	document.documentElement.setAttribute("data-theme", state.settings.theme);
	document.documentElement.setAttribute("data-font", state.settings.font);
	const meta = document.querySelector("meta[name=\"theme-color\"]");
	if (meta) {
		const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
		if (surface) meta.setAttribute("content", surface);
	}
}
function renderSettingsModal() {
	document.querySelectorAll("#theme-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === state.settings.theme);
	});
	document.querySelectorAll("#font-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === state.settings.font);
	});
	document.querySelectorAll("#send-options .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === state.settings.sendKey);
	});
	$("#notif-toggle").checked = state.settings.notifications;
}
var credConfigWired = false;
async function renderCredentialsSettings() {
	const section = $("#settings-credentials");
	if (!section) return;
	let cfg;
	try {
		const r = await authFetch("/api/webchat/credentials-config");
		if (!r.ok) {
			section.hidden = true;
			return;
		}
		cfg = await r.json();
	} catch {
		section.hidden = true;
		return;
	}
	if (!cfg.canEdit) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	document.querySelectorAll("#cred-default-mode .setting-option").forEach((btn) => {
		btn.classList.toggle("active", btn.dataset.value === cfg.defaultMode);
	});
	const providerOn = {
		claude: !!(cfg.allowAnthropicKey && cfg.allowClaudeOauth),
		codex: !!(cfg.allowOpenaiKey && cfg.allowCodexOauth)
	};
	const providerAvailable = {
		claude: true,
		codex: !!cfg.codexAvailable
	};
	document.querySelectorAll("#cred-providers .setting-option").forEach((btn) => {
		const p = btn.dataset.provider ?? "";
		btn.classList.toggle("active", !!providerOn[p]);
		btn.classList.toggle("is-unavailable", !providerAvailable[p]);
	});
	const codexRow = $("#settings-codex-install");
	if (codexRow) codexRow.hidden = false;
	const codexInstallBtn = $("#codex-install-btn");
	const codexBadge = $("#codex-installed-badge");
	if (codexInstallBtn && !codexInstallActive.value) codexInstallBtn.hidden = !!cfg.codexAvailable;
	if (codexBadge) codexBadge.hidden = !cfg.codexAvailable;
	const opencodeRow = $("#settings-opencode-install");
	if (opencodeRow) opencodeRow.hidden = false;
	const opencodeInstallBtn = $("#opencode-install-btn");
	const opencodeBadge = $("#opencode-installed-badge");
	if (opencodeInstallBtn && !opencodeInstallActive.value) opencodeInstallBtn.hidden = !!cfg.opencodeAvailable;
	if (opencodeBadge) opencodeBadge.hidden = !cfg.opencodeAvailable;
	const piRow = $("#settings-pi-install");
	if (piRow) piRow.hidden = false;
	const piInstallBtn = $("#pi-install-btn");
	const piBadge = $("#pi-installed-badge");
	if (piInstallBtn && !opencodeInstallActive.value) piInstallBtn.hidden = !!cfg.piAvailable;
	if (piBadge) piBadge.hidden = !cfg.piAvailable;
	if (credConfigWired) return;
	credConfigWired = true;
	$("#codex-install-btn")?.addEventListener("click", () => runCodexInstall(CODEX_SETTINGS_ELS));
	$("#opencode-install-btn")?.addEventListener("click", () => runOpencodeInstall(OPENCODE_SETTINGS_ELS));
	$("#pi-install-btn")?.addEventListener("click", () => runOpencodeInstall(PI_SETTINGS_ELS));
	const putConfig = async (patch) => {
		const r = await authFetch("/api/webchat/credentials-config", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify(patch)
		});
		if (!r.ok) {
			showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			renderCredentialsSettings();
			return false;
		}
		return true;
	};
	document.querySelectorAll("#cred-default-mode .setting-option").forEach((btn) => {
		btn.addEventListener("click", async () => {
			if (await putConfig({ defaultMode: btn.dataset.value })) {
				document.querySelectorAll("#cred-default-mode .setting-option").forEach((b) => b.classList.toggle("active", b === btn));
				if (state.currentRoom) deps$3.updateUserCredsBanner(state.currentRoom);
			}
		});
	});
	const PROVIDER_FLAGS = {
		claude: ["allowAnthropicKey", "allowClaudeOauth"],
		codex: ["allowOpenaiKey", "allowCodexOauth"]
	};
	const PROVIDER_UNAVAILABLE = {
		codex: "Codex isn’t installed yet — use “Install Codex…” above to add it.",
		claude: "Claude isn’t available in this workspace."
	};
	document.querySelectorAll("#cred-providers .setting-option").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const p = btn.dataset.provider ?? "";
			if (btn.classList.contains("is-unavailable")) {
				showToast(PROVIDER_UNAVAILABLE[p] || "This provider isn’t available yet.", {
					kind: "info",
					timeout: 9e3
				});
				return;
			}
			const [keyFlag, oauthFlag] = PROVIDER_FLAGS[p] || [];
			if (!keyFlag) return;
			const on = !btn.classList.contains("active");
			if (await putConfig({
				[keyFlag]: on,
				[oauthFlag]: on
			})) {
				btn.classList.toggle("active", on);
				if (state.currentRoom) deps$3.updateUserCredsBanner(state.currentRoom);
			}
		});
	});
}
var accessBearerWired = false;
var accessHttpsWired = false;
async function renderAccessSettings() {
	const section = $("#settings-access");
	if (!section) return;
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	section.hidden = !info;
	if (!info) return;
	const btn = $("#access-bearer-btn");
	if (!accessBearerWired) {
		accessBearerWired = true;
		btn?.addEventListener("click", () => deps$3.toggleBearerToken(btn.dataset.want === "enable"));
	}
	clearTimeout(bearerConfirmTimer.value ?? void 0);
	btn.dataset.confirming = "";
	const badge = $("#access-bearer-badge");
	const setBadge = (text, title) => {
		badge.hidden = false;
		badge.textContent = text;
		badge.title = title;
	};
	if (!info.bearerConfigured) {
		btn.hidden = true;
		setBadge("Not set", "No bearer token is configured — access is controlled by your other auth method.");
	} else if (info.bearerActive && info.canDisableBearer) {
		btn.hidden = false;
		btn.dataset.want = "disable";
		btn.textContent = "Disable";
		setBadge("Active", "You also have Tailscale or SSO, so the shared bearer token is no longer needed.");
	} else if (info.bearerActive) {
		btn.hidden = true;
		setBadge("Required", "Required for access. Set up Tailscale or SSO to retire this shared token.");
	} else {
		btn.hidden = false;
		btn.dataset.want = "enable";
		btn.textContent = "Re-enable";
		setBadge("Disabled", "Access is via Tailscale or SSO. The token in .env is ignored until re-enabled.");
	}
	renderHttpsSettings();
}
async function renderHttpsSettings() {
	const row = $("#access-https-row");
	const hint = $("#access-https-hint");
	const btn = $("#access-https-btn");
	if (!row || !hint || !btn) return;
	if (!accessHttpsWired) {
		accessHttpsWired = true;
		btn.addEventListener("click", () => enableTailscaleHttps());
	}
	let state = null;
	try {
		const r = await authFetch("/api/webchat/tailscale-https");
		if (r.ok) state = await r.json();
	} catch {
		state = null;
	}
	if (!state || !state.available) {
		row.hidden = true;
		hint.hidden = true;
		return;
	}
	row.hidden = false;
	const badge = $("#access-https-badge");
	hint.hidden = true;
	if (state.active) {
		btn.hidden = true;
		badge.hidden = false;
		badge.title = `${state.url || "HTTPS via Tailscale"} — only reachable over your tailnet.`;
	} else {
		badge.hidden = true;
		btn.hidden = false;
		btn.disabled = false;
		btn.textContent = "Enable";
		btn.title = "Serve over Tailscale with a real certificate — enables PWA install, push, and voice.";
	}
}
var CODEX_SETTINGS_ELS = {
	btn: "#codex-install-btn",
	log: "#codex-install-log",
	progress: "#codex-install-progress"
};
var OPENCODE_SETTINGS_ELS = {
	btn: "#opencode-install-btn",
	log: "#opencode-install-log",
	progress: "#opencode-install-progress"
};
var PI_SETTINGS_ELS = {
	btn: "#pi-install-btn",
	log: "#pi-install-log",
	progress: "#pi-install-progress",
	url: "/api/pi/install",
	name: "pi",
	doneMsg: "pi installed — switch an agent to it under Agent → Harness."
};
/**
* About — what this install is actually running.
*
* Nothing reported that before. The nanoclaw version was readable only from
* package.json on the box, and the webchat overlay had no version at all: this
* repo's versions.json is a build input that never ships, and the install's own
* versions.json is nanoclaw's onecli/agent pins — a different file with the
* same name. install.sh now stamps `.webchat-provenance.json`, which is where
* the webchat rows come from.
*
* Read-only by design. Both components update through git against a customised
* tree, so there is no honest one-click here — the hint under the rows says so
* rather than implying a button is coming.
*
* Gated by the endpoint, not a role flag: /api/system/versions is anyAdmin, so
* a 403 hides the section the same way the other probe-gated sections work.
*/
async function renderAboutSettings() {
	const section = $("#settings-about");
	if (!section) return;
	let v = null;
	try {
		const res = await authFetch("/api/system/versions");
		if (res.ok) v = await res.json();
	} catch {
		v = null;
	}
	if (!v) {
		section.hidden = true;
		return;
	}
	const short = (sha) => typeof sha === "string" && sha ? sha.slice(0, 12) : null;
	const withDirty = (sha, dirty) => sha ? sha + (dirty ? " (modified)" : "") : null;
	const rows = [
		["nanoclaw", v.nanoclaw?.version ?? null],
		["nanoclaw commit", withDirty(short(v.nanoclaw?.commit), v.nanoclaw?.dirty)],
		["webchat", v.webchat ? withDirty(short(v.webchat.ref), v.webchat.dirty) : "unknown — reinstall to stamp"],
		["webchat composed", v.webchat?.composedAt ? String(v.webchat.composedAt).replace("T", " ").replace("+00:00", " UTC") : null],
		["upstream pin", short(v.webchat?.upstreamRef)],
		["seam pin", short(v.webchat?.seamRef)]
	];
	for (const [k, val] of Object.entries(v.components ?? {})) rows.push([k, String(val)]);
	const dl = $("#about-rows");
	dl.textContent = "";
	for (const [k, val] of rows) {
		if (!val) continue;
		const dt = document.createElement("dt");
		dt.textContent = k;
		const dd = document.createElement("dd");
		dd.textContent = val;
		dl.append(dt, dd);
	}
	section.hidden = false;
}
var auditWired = false;
/**
* Audit section — owner-only, gated by the endpoint like every other
* probe-gated section (403 → no surface). The status line is DATA, not
* standing prose: delivery counts and the last error, or nothing. The
* what/why copy lives behind the ⓘ per DESIGN.md.
*/
async function renderAuditSettings() {
	const section = $("#settings-audit");
	if (!section) return;
	let info = null;
	try {
		const res = await authFetch("/api/webchat/audit-syslog");
		if (res.ok) info = await res.json();
	} catch {
		info = null;
	}
	if (!info) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	const input = $("#audit-syslog-target");
	if (input && document.activeElement !== input) input.value = info.target || "";
	const statusEl = $("#audit-syslog-status");
	if (statusEl) {
		const st = info.status || {};
		if (!info.target) statusEl.hidden = true;
		else {
			const parts = [];
			parts.push(`${st.sentCount ?? 0} sent`);
			if (st.lastSentAt) parts.push(`last ${new Date(st.lastSentAt).toLocaleTimeString()}`);
			if (st.droppedCount) parts.push(`${st.droppedCount} dropped`);
			if (st.lastError && (!st.lastSentAt || st.lastErrorAt > st.lastSentAt)) parts.push(`error: ${st.lastError}`);
			statusEl.textContent = parts.join(" · ");
			statusEl.hidden = false;
		}
	}
	if (auditWired) return;
	auditWired = true;
	$("#audit-syslog-apply")?.addEventListener("click", async () => {
		const target = ($("#audit-syslog-target")?.value || "").trim();
		const r = await authFetch("/api/webchat/audit-syslog", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ target })
		});
		if (!r.ok) {
			showToast("Audit forwarding not changed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return;
		}
		showToast(target ? "Audit forwarding on — the change was recorded to both collectors" : "Audit forwarding off", { kind: "success" });
		renderAuditSettings();
	});
}
/**
* Backup section — owner-only, and until now the ONE section in Settings that
* started visible with no gate at all. Every other section ships `hidden` in
* the markup and reveals itself only after its own capability probe passes,
* so they fail closed; this one failed open and showed a member three buttons
* that could only ever 403 (`/api/system/export` and `/api/system/import`
* both carry `guards: ['owner']`).
*
* `state.isOwnerView` is the same signal the secrets, skill-sources and
* prejudge sections use, so this stays consistent with its neighbours rather
* than adding a fourth way to ask the same question.
*/
function renderBackupSettings() {
	const section = $("#settings-backup");
	if (!section) return;
	section.hidden = !state.isOwnerView;
}
/**
* Hide the "Features" column when every feature inside it is hidden.
*
* The column is a heading plus four independently-gated sections (TTS, STT,
* auto-learn, credential isolation). Gate the column on a role and it breaks
* for whoever holds a role the column doesn't model — a global admin sees
* auto-learn and credential isolation but is not an owner. So derive it from
* the children instead: the column is worth showing iff something is in it.
*
* Runs after the async gates settle. Each child render hides itself on a 403
* that we cannot observe synchronously, so calling this inline with
* openSettings would always see the pre-fetch state.
*/
function syncFeaturesColumn() {
	const col = $("#settings-features-col");
	if (!col) return;
	col.hidden = ![...col.querySelectorAll(".settings-feature")].some((e) => !e.hasAttribute("hidden"));
}
function openSettings() {
	renderSettingsModal();
	Promise.allSettled([renderTtsSetupSettings(), renderSttSetupSettings()]).then(syncFeaturesColumn);
	renderMyCredentials();
	$("#settings-overlay").hidden = false;
	const focusable = $("#settings-overlay .modal").querySelectorAll("button, input, select, [tabindex]:not([tabindex=\"-1\"])");
	if (focusable.length) focusable[0].focus();
}
function closeSettings() {
	$("#settings-overlay").hidden = true;
}
var ttsInstallWired = false;
async function renderTtsSetupSettings() {
	const section = $("#settings-tts");
	if (!section) return;
	const btn = $("#tts-install-btn");
	const badge = $("#tts-installed-badge");
	const progress = $("#tts-install-progress");
	if (!ttsInstallWired) {
		ttsInstallWired = true;
		btn.addEventListener("click", () => runTtsInstall());
		$("#tts-voice-select")?.addEventListener("change", async () => {
			const voice = $("#tts-voice-select").value;
			const r = await authFetch("/api/tts/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ voice })
			});
			if (!r.ok) {
				showToast("Failed to save voice: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				renderTtsSetupSettings();
				return;
			}
			showToast("Voice saved", { kind: "success" });
			try {
				const sample = await authFetch("/api/tts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text: "This is how I sound.",
						voice
					})
				});
				if (sample.ok) {
					const blob = await sample.blob();
					new Audio(URL.createObjectURL(blob)).play();
				}
			} catch {}
		});
	}
	let st = null;
	try {
		const res = await authFetch("/api/webchat/tts/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	await loadTtsConfig();
	const readAloudToggle = $("#tts-readaloud-toggle");
	if (readAloudToggle) readAloudToggle.checked = getTtsReadAloudEnabled();
	const desc = $("#tts-setup-desc");
	if (st.installed) {
		btn.hidden = true;
		badge.hidden = false;
		if (desc) desc.hidden = true;
		progress.hidden = !st.running;
		if (st.running) pollTtsInstall();
		try {
			const [voicesRes, cfgRes] = await Promise.all([authFetch("/api/tts/voices"), authFetch("/api/tts/config")]);
			if (voicesRes.ok) {
				const { voices } = await voicesRes.json();
				const cfg = cfgRes.ok ? await cfgRes.json() : {};
				const select = $("#tts-voice-select");
				if (select && Array.isArray(voices) && voices.length) {
					select.innerHTML = "";
					for (const v of voices) {
						const opt = document.createElement("option");
						opt.value = v;
						opt.textContent = v;
						select.appendChild(opt);
					}
					if (cfg.voice) select.value = cfg.voice;
					if (cfg.model) {
						const label = $("#tts-voice-label");
						if (label) label.textContent = `Voice (${cfg.model.charAt(0).toUpperCase()}${cfg.model.slice(1)})`;
					}
					$("#tts-voice-group").hidden = false;
				}
			}
		} catch {}
		return;
	}
	badge.hidden = true;
	$("#tts-voice-group").hidden = true;
	btn.hidden = !st.installerPresent;
	if (desc) {
		desc.hidden = false;
		if (st.installerPresent) desc.textContent = "Using each device’s built-in voices.";
		else desc.textContent = "Server voices need the add-webchat-tts skill, which isn’t in this install — re-run install-webchat.sh to add it. Device voices still work.";
	}
	if (st.running) pollTtsInstall();
	else {
		btn.disabled = false;
		btn.textContent = "Install local voices";
		btn.title = "Run a local Kokoro voice model (~330MB, no cloud, no key). Without it the control uses your device voices.";
	}
}
var sttInstallWired = false;
var sttLastState = null;
async function renderSttSetupSettings() {
	const section = $("#settings-stt");
	if (!section) return;
	let st = null;
	try {
		const res = await authFetch("/api/webchat/stt/install");
		if (res.ok) st = await res.json();
	} catch {
		st = null;
	}
	if (!st) {
		section.hidden = true;
		return;
	}
	sttLastState = st;
	section.hidden = false;
	const btn = $("#stt-install-btn");
	const badge = $("#stt-installed-badge");
	const progress = $("#stt-install-progress");
	const desc = $("#stt-setup-desc");
	if (!sttInstallWired) {
		sttInstallWired = true;
		document.querySelectorAll("#stt-backend-mode .setting-option").forEach((b) => {
			b.addEventListener("click", () => {
				sttChosenBackend.value = b.dataset.value ?? "local";
				renderSttSetupSettings();
			});
		});
		btn?.addEventListener("click", () => {
			runSttInstall({
				provider: "local",
				model: $("#stt-model-select")?.value || void 0
			});
		});
		document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((b) => {
			b.addEventListener("click", async () => {
				const on = b.dataset.value === "on";
				const r = await authFetch("/api/stt/config", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: on })
				});
				if (!r.ok) {
					showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
					return;
				}
				document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((x) => x.classList.toggle("active", x === b));
				const mic = $("#mic-btn");
				if (mic) mic.hidden = !on;
				if (!on && isDictationActive()) cancelDictation();
				showToast(on ? "Voice dictation on for everyone" : "Voice dictation off for everyone");
			});
		});
		$("#stt-model-select")?.addEventListener("change", () => {
			if (!sttLastState?.installed || sttLastState.provider !== "local") return;
			const model = $("#stt-model-select").value;
			if (!model || model === sttLastState.model) return;
			showToast(`Switching to ${model}…`, { kind: "info" });
			runSttInstall({
				provider: "local",
				model
			});
		});
		$("#stt-connect-btn")?.addEventListener("click", () => {
			const key = ($("#stt-api-key")?.value || "").trim();
			if (!key) {
				showToast("Enter the ElevenLabs API key first", { kind: "error" });
				return;
			}
			runSttInstall({
				provider: "elevenlabs",
				apiKey: key
			});
			$("#stt-api-key").value = "";
		});
		$("#stt-prompt-edit")?.addEventListener("click", () => {
			const editor = $("#stt-prompt-editor");
			const open = editor.hidden;
			editor.hidden = !open;
			$("#stt-prompt-edit").setAttribute("aria-expanded", String(open));
			if (open) $("#stt-prompt-text").focus();
		});
		$("#stt-prompt-save")?.addEventListener("click", async () => {
			const value = $("#stt-prompt-text").value.trim();
			const r = await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupPrompt: value || null })
			});
			const body = await r.json().catch(() => ({}));
			if (!r.ok) {
				showToast("Failed to save: " + (body.error || r.statusText), { kind: "error" });
				return;
			}
			$("#stt-prompt-editor").hidden = true;
			$("#stt-prompt-edit").setAttribute("aria-expanded", "false");
			showToast(body.cleanupPrompt ? "Cleanup prompt saved" : "Cleanup prompt reset to default", { kind: "success" });
			renderSttSetupSettings();
		});
		$("#stt-prompt-reset")?.addEventListener("click", async () => {
			if (!(await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupPrompt: null })
			})).ok) {
				showToast("Failed to reset", { kind: "error" });
				return;
			}
			$("#stt-prompt-editor").hidden = true;
			$("#stt-prompt-edit").setAttribute("aria-expanded", "false");
			showToast("Cleanup prompt reset to default", { kind: "success" });
			renderSttSetupSettings();
		});
		$("#stt-cleanup-select")?.addEventListener("change", async () => {
			const value = $("#stt-cleanup-select").value || null;
			const r = await authFetch("/api/stt/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cleanupModelId: value })
			});
			if (!r.ok) {
				showToast("Failed to save: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
				renderSttSetupSettings();
				return;
			}
			setSttConfig({
				...getSttConfig(),
				cleanup: value !== null,
				cleanupModelId: value
			});
			showToast(value ? "Cleanup model saved" : "Cleanup turned off", { kind: "success" });
		});
	}
	if (st.installed) {
		badge.hidden = false;
		btn.hidden = true;
		$("#stt-backend-group").hidden = true;
		$("#stt-key-group").hidden = true;
		$("#stt-enabled-group").hidden = false;
		document.querySelectorAll("#stt-enabled-mode .setting-option").forEach((b) => {
			b.classList.toggle("active", b.dataset.value === (st.enabled ? "on" : "off"));
		});
		const localModel = st.provider === "local" && st.installerPresent;
		$("#stt-model-group").hidden = !localModel;
		if (localModel) {
			sttPopulateModelSelect(st);
			const label = $("#stt-model-label");
			if (label) label.textContent = "Model (Whisper)";
		}
		if (desc) desc.hidden = true;
		progress.hidden = !st.running;
		if (st.running) pollSttInstall();
		try {
			const cfg = await (await authFetch("/api/stt/config")).json();
			if (cfg.canEdit) {
				await renderSttCleanupSelect(cfg);
				$("#stt-prompt-row").hidden = false;
				$("#stt-prompt-text").value = cfg.cleanupPrompt || cfg.defaultCleanupPrompt || "";
				$("#stt-prompt-reset").hidden = !cfg.cleanupPrompt;
			}
		} catch {}
		return;
	}
	badge.hidden = true;
	$("#stt-enabled-group").hidden = true;
	$("#stt-cleanup-group").hidden = true;
	$("#stt-prompt-row").hidden = true;
	$("#stt-prompt-editor").hidden = true;
	$("#stt-backend-group").hidden = false;
	if (desc) {
		desc.hidden = st.installerPresent || sttChosenBackend.value !== "local";
		if (!st.installerPresent) desc.textContent = "The local backend needs the add-webchat-dictation skill, which isn’t in this install — re-run install-webchat.sh to add it, or use ElevenLabs.";
	}
	sttRenderBackendChoice(st);
	if (st.running) pollSttInstall();
	else if (btn) {
		btn.disabled = false;
		btn.textContent = "Install";
		btn.title = "Run whisper.cpp locally with the selected model — no cloud, no key. Model download sized to this machine.";
	}
}
var prejudgeOptionsApp = null;
function mountPrejudgeModelOptions() {
	if (prejudgeOptionsApp) return;
	const host = $("#prejudge-model-select");
	if (!host) return;
	prejudgeOptionsApp = createApp(PrejudgeModelOptions_default);
	prejudgeOptionsApp.mount(host);
}
async function renderPrejudgeSettings() {
	const section = $("#settings-prejudge");
	if (!section) return;
	section.hidden = !state.isOwnerView;
	if (!state.isOwnerView) return;
	let cfg = null;
	try {
		const r = await authFetch("/api/approvals/prejudge");
		if (r.ok) cfg = await r.json();
	} catch {}
	if (!cfg) {
		section.hidden = true;
		return;
	}
	const sel = $("#prejudge-model-select");
	let options = [];
	try {
		options = (await (await authFetch("/api/models")).json()).filter((m) => m.kind === "anthropic" || (m.kind === "ollama" || m.kind === "openai-compatible") && m.endpoint).map((m) => ({
			id: m.id,
			label: `${m.name} (${m.model_id})`
		}));
	} catch {}
	prejudgeModelOptions.value = options;
	mountPrejudgeModelOptions();
	await nextTick();
	sel.value = cfg.modelId || "";
	if (sel.value !== (cfg.modelId || "")) sel.value = "";
	renderPrejudgeActions(cfg);
	sel.onchange = async () => {
		try {
			const out = await apiJson("/api/approvals/prejudge", {
				method: "PUT",
				body: { modelId: sel.value || null }
			});
			showToast(sel.value ? "Approval pre-judge on" : "Approval pre-judge off", { kind: "success" });
			renderPrejudgeActions(out);
		} catch (err) {
			showToast("Could not save: " + (err?.message || err), { kind: "error" });
			renderPrejudgeSettings();
		}
	};
}
var routingInstallWired = false;
async function renderRoutingSetup() {
	const section = $("#routing-setup");
	let st;
	try {
		const res = await authFetch("/api/router/install");
		if (!res.ok) {
			section.hidden = true;
			return;
		}
		st = await res.json();
	} catch {
		section.hidden = true;
		return;
	}
	section.hidden = false;
	const btn = $("#routing-install-btn");
	const desc = $("#routing-setup-desc");
	const badge = $("#routing-installed-badge");
	const progress = $("#routing-install-progress");
	if (!routingInstallWired) {
		routingInstallWired = true;
		btn.addEventListener("click", runRoutingInstall);
	}
	const pulling = Boolean(st.pull && st.pull.status === "pulling");
	const busy = st.running || pulling;
	if (st.installed) {
		btn.hidden = true;
		desc.hidden = true;
		badge.hidden = false;
		if (busy) {
			progress.hidden = false;
			renderRoutingInstallProgress(st);
			pollRoutingInstall();
		} else progress.hidden = true;
		return;
	}
	badge.hidden = true;
	btn.hidden = false;
	btn.textContent = busy ? "Installing…" : "Install";
	btn.disabled = busy;
	desc.hidden = true;
	if (busy) {
		progress.hidden = false;
		renderRoutingInstallProgress(st);
		pollRoutingInstall();
	} else progress.hidden = true;
}
async function enableWebPush({ interactive = false } = {}) {
	const fail = (msg, err) => {
		console.warn("[push]", msg, err ?? "");
		if (interactive) showToast(msg, { kind: "error" });
	};
	try {
		if (!("serviceWorker" in navigator)) return fail("Notifications aren’t supported in this browser");
		if (!("PushManager" in window)) {
			console.warn("[push] PushManager unavailable");
			if (interactive) showToast("To enable notifications on iOS, add this app to your home screen and open it from there", {
				kind: "info",
				timeout: 6e3
			});
			return;
		}
		console.log("[push] fetching VAPID key");
		const keyRes = await authFetch("/api/push/vapid-public");
		if (!keyRes.ok) return fail("Couldn’t enable notifications — the server has no push key");
		const { key } = await keyRes.json();
		if (!key) return fail("Couldn’t enable notifications — the server has no push key");
		const reg = await navigator.serviceWorker.ready;
		let sub = await reg.pushManager.getSubscription();
		if (!sub) {
			console.log("[push] subscribing");
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(key)
			});
		} else console.log("[push] reusing existing subscription");
		if (!(await authFetch("/api/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(sub.toJSON())
		})).ok) return fail("Couldn’t save your notification subscription");
		console.log("[push] subscribed", sub.endpoint.slice(-24));
		if (interactive) showToast("Notifications enabled", { kind: "success" });
	} catch (err) {
		fail("Couldn’t enable notifications", err);
	}
}
async function disableWebPush() {
	try {
		if (!("serviceWorker" in navigator)) return;
		const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
		if (sub) {
			await authFetch("/api/push/unsubscribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: sub.endpoint })
			});
			await sub.unsubscribe();
			console.log("[push] unsubscribed");
		}
	} catch (err) {
		console.error("[push] unsubscribe failed:", err);
	}
}
function urlBase64ToUint8Array(base64String) {
	const base64 = (base64String + "=".repeat((4 - base64String.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const buf = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
	return buf;
}
function wireSettingsPanel1() {
	$("#settings-overlay")?.addEventListener("click", (e) => {
		if (e.target === $("#settings-overlay")) closeSettings();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !$("#settings-overlay")?.hidden) closeSettings();
	});
}
function wireSettingsPanel2() {
	document.querySelectorAll("#theme-options .setting-option").forEach((btn) => {
		btn.addEventListener("click", () => {
			if (state.settings) state.settings.theme = btn.dataset.value;
			if (state.settings) saveSettings(state.settings);
			applySettings();
			renderSettingsModal();
		});
	});
	document.querySelectorAll("#font-options .setting-option").forEach((btn) => {
		btn.addEventListener("click", () => {
			if (state.settings) state.settings.font = btn.dataset.value;
			if (state.settings) saveSettings(state.settings);
			applySettings();
			renderSettingsModal();
		});
	});
	document.querySelectorAll("#send-options .setting-option").forEach((btn) => {
		btn.addEventListener("click", () => {
			if (state.settings) state.settings.sendKey = btn.dataset.value;
			if (state.settings) saveSettings(state.settings);
			renderSettingsModal();
		});
	});
	const readAloud = $("#tts-readaloud-toggle");
	readAloud?.addEventListener("change", async () => {
		const on = readAloud.checked;
		readAloud.disabled = true;
		try {
			const r = await authFetch("/api/tts/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ readAloud: on })
			});
			if (!r.ok) {
				const err = await r.json().catch(() => ({}));
				readAloud.checked = !on;
				showToast("Failed to save: " + (err.error || r.statusText), { kind: "error" });
				return;
			}
			setTtsReadAloudEnabled(on);
			if (!on) stopTts();
			showToast(on ? "Read aloud on for everyone — hover an agent reply for the speaker" : "Read aloud off for everyone");
		} finally {
			readAloud.disabled = false;
		}
	});
	const notifToggle = $("#notif-toggle");
	notifToggle?.addEventListener("change", async () => {
		if (notifToggle.checked) {
			if (Notification.permission !== "granted") {
				if (await Notification.requestPermission() !== "granted") {
					notifToggle.checked = false;
					if (state.settings) state.settings.notifications = false;
					if (state.settings) saveSettings(state.settings);
					showToast("Notifications need browser permission to turn on", { kind: "info" });
					return;
				}
			}
			await enableWebPush({ interactive: true });
		} else await disableWebPush();
		if (state.settings) state.settings.notifications = notifToggle.checked;
		if (state.settings) saveSettings(state.settings);
	});
}
async function enableTailscaleHttps() {
	const hint = $("#access-https-hint");
	const btn = $("#access-https-btn");
	btn.disabled = true;
	btn.textContent = "Enabling…";
	try {
		const r = await authFetch("/api/webchat/tailscale-https", {
			method: "POST",
			headers: { "X-Webchat-CSRF": "1" }
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok && data.ok) showToast("HTTPS enabled over Tailscale", { kind: "success" });
		else {
			const parts = [data.error, data.hint].filter(Boolean).join(" ");
			showToast(data.error || "Could not enable HTTPS", {
				kind: "error",
				timeout: 9e3
			});
			if (parts) {
				hint.hidden = false;
				hint.innerHTML = data.hintUrl ? `${esc(parts)} <a href="${esc(data.hintUrl)}" target="_blank" rel="noopener">Open admin console</a>` : esc(parts);
			}
		}
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		renderHttpsSettings();
	}
}
/** Populate the cleanup select from the roster (owner path of /api/stt/config). */
async function renderSttCleanupSelect(cfg) {
	const group = $("#stt-cleanup-group");
	const select = $("#stt-cleanup-select");
	if (!group || !select) return;
	group.hidden = false;
	try {
		const models = await (await authFetch("/api/models")).json();
		select.innerHTML = "<option value=\"\">None — raw transcript</option>";
		for (const m of models) {
			if (m.kind !== "ollama" && m.kind !== "openai-compatible" || !m.endpoint) continue;
			const opt = document.createElement("option");
			opt.value = m.id;
			opt.textContent = `${m.name} (${m.model_id})`;
			select.appendChild(opt);
		}
		select.value = cfg.cleanupModelId || "";
	} catch {}
}
/** Show/hide the pre-install pickers for the chosen backend. */
function sttRenderBackendChoice(st) {
	document.querySelectorAll("#stt-backend-mode .setting-option").forEach((b) => b.classList.toggle("active", b.dataset.value === sttChosenBackend.value));
	const local = sttChosenBackend.value === "local";
	$("#stt-model-group").hidden = !local || !st.installerPresent;
	$("#stt-install-btn").hidden = !local || !st.installerPresent;
	$("#stt-key-group").hidden = local;
	if (local) sttPopulateModelSelect(st);
}
async function renderSelfTest() {
	const section = $("#settings-selftest");
	if (!section) return;
	let ok = false;
	try {
		ok = (await authFetch("/api/workspace-credential")).ok;
	} catch {
		ok = false;
	}
	section.hidden = !ok;
	if (!ok || selftestWired) return;
	selftestWired = true;
	const btn = $("#selftest-run-btn");
	const out = $("#selftest-results");
	function mountPreflight() {
		if (preflightApp) return;
		if (!out) return;
		preflightApp = createApp(Preflight_default, { onCopy: async (text) => {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				showToast("Copy failed — select the text manually.", { kind: "error" });
				return false;
			}
		} });
		preflightApp.mount(out);
	}
	btn?.addEventListener("click", async () => {
		btn.disabled = true;
		const orig = btn.textContent;
		btn.textContent = "Running…";
		out.hidden = false;
		preflightMessage.value = "Running checks (this may spin a probe container)…";
		preflightPhase.value = "running";
		mountPreflight();
		try {
			const res = await authFetch("/api/webchat/preflight");
			const data = await res.json();
			if (!res.ok) {
				preflightMessage.value = data.error || res.statusText;
				preflightPhase.value = "message";
				return;
			}
			const checks = data.checks || [];
			if (!checks.length) {
				preflightMessage.value = "No checks ran.";
				preflightPhase.value = "message";
				return;
			}
			preflightChecks.value = checks.map((c) => ({
				status: c.status,
				head: `${PREFLIGHT_ICON[c.status] || "•"} ${c.label} — ${c.detail}`,
				fix: c.fix || ""
			}));
			preflightPhase.value = "checks";
		} catch (err) {
			preflightMessage.value = String(err?.message || err);
			preflightPhase.value = "message";
		} finally {
			btn.disabled = false;
			btn.textContent = orig;
		}
	});
}
function renderCredentialIsolation(feats) {
	const box = $("#settings-credential-isolation");
	if (!box) return;
	box.hidden = !feats.canEdit;
	if (!feats.canEdit) return;
	const toggle = $("#credential-isolation-toggle");
	toggle.checked = feats.credentialIsolationEffective === true;
	const envNote = $("#credential-isolation-env");
	const following = feats.credentialIsolation === null || feats.credentialIsolation === void 0;
	envNote.hidden = !following;
	if (following) envNote.textContent = "Following CREDENTIAL_ISOLATION in .env";
	if (toggle.dataset.wired) return;
	toggle.dataset.wired = "1";
	toggle.addEventListener("change", async () => {
		const want = toggle.checked;
		toggle.disabled = true;
		try {
			if (!(await authFetch("/api/webchat/features", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-Webchat-CSRF": "1"
				},
				body: JSON.stringify({ credentialIsolation: want })
			})).ok) throw new Error("save failed");
			envNote.hidden = true;
			showToast(want ? "Credential isolation on — applies as agents restart" : "Credential isolation off");
		} catch {
			toggle.checked = !want;
			showToast("Could not change credential isolation", { kind: "error" });
		} finally {
			toggle.disabled = false;
		}
	});
}
function mountPrejudgeActions() {
	if (prejudgeApp) return;
	const host = $("#prejudge-actions-list");
	if (!host) return;
	prejudgeApp = createApp(PrejudgeActions_default, { onToggle: async (cb) => {
		const next = [...$("#prejudge-actions-list").querySelectorAll("input:not(:disabled):checked")].map((el) => el.dataset.action);
		try {
			await apiJson("/api/approvals/prejudge", {
				method: "PUT",
				body: { actions: next }
			});
			showToast("Approval pre-judge saved", { kind: "success" });
		} catch (err) {
			cb.checked = !cb.checked;
			showToast("Could not save: " + (err?.message || err), { kind: "error" });
		}
	} });
	prejudgeApp.mount(host);
}
function renderPrejudgeActions(cfg) {
	const group = $("#prejudge-actions-group");
	if (!group || !$("#prejudge-actions-list")) return;
	group.hidden = !cfg.modelId;
	if (!cfg.modelId) return;
	const never = new Set(cfg.neverList?.actions || []);
	const opted = new Set(cfg.actions || []);
	prejudgeRows.value = [.../* @__PURE__ */ new Set([
		...cfg.knownActions || [],
		...never,
		...opted
	])].sort().map((action) => ({
		action,
		checked: opted.has(action) && !never.has(action),
		never: never.has(action)
	}));
	mountPrejudgeActions();
}
function mountMyCredentials() {
	if (myCredsApp) return;
	const host = $("#my-credentials-list");
	if (!host) return;
	myCredsApp = createApp(MyCredentials_default, {
		onRemove: async (group, sec) => {
			await removeToolSecret({
				agentGroupId: group.agentGroupId,
				userId: permsMyUserId.value
			}, sec, null);
			await renderMyCredentials();
		},
		onAdd: async (group, hostPattern, value, fields) => {
			if (!hostPattern || !value) {
				showToast("Host and value are required", { kind: "error" });
				return;
			}
			const scope = {
				agentGroupId: group.agentGroupId,
				userId: permsMyUserId.value
			};
			myCredSaving.value = new Set(myCredSaving.value).add(group.agentGroupId);
			try {
				const r = await authFetch(toolSecretUrl(scope), {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Webchat-CSRF": "1"
					},
					body: JSON.stringify({
						hostPattern,
						value
					})
				});
				if (!r.ok) {
					showToast((await r.json().catch(() => ({}))).error || "Could not add secret", { kind: "error" });
					return;
				}
				for (const el of fields) el.value = "";
				showToast(`Added ${hostPattern}`);
				await renderMyCredentials();
			} catch {
				showToast("Could not add secret", { kind: "error" });
			} finally {
				const next = new Set(myCredSaving.value);
				next.delete(group.agentGroupId);
				myCredSaving.value = next;
			}
		}
	});
	myCredsApp.mount(host);
}
async function renderMyCredentials() {
	const section = $("#settings-my-credentials");
	if (!section) return;
	let groups = [];
	try {
		const r = await authFetch("/api/tool-secrets/mine");
		if (r.ok) groups = (await r.json()).groups || [];
	} catch {
		groups = [];
	}
	section.hidden = groups.length === 0;
	if (!groups.length) return;
	if (!$("#my-credentials-list")) return;
	myCredGroups.value = groups;
	mountMyCredentials();
}
var preflightApp = null;
var selftestWired = false;
var PREFLIGHT_ICON = {
	ok: "✓",
	warn: "⚠",
	fail: "✕",
	info: "•"
};
var prejudgeApp = null;
var myCredsApp = null;
//#endregion
//#region src/core/ws.ts
var deps$2 = {};
/** Wire the legacy helpers the dispatcher calls. Call once at startup. */
function provideWsDeps(provided) {
	Object.assign(deps$2, provided);
}
function setConnectionBanner(text, offerOpenTailscale = false) {
	const banner = $("#connection-banner");
	if (!banner) return;
	banner.replaceChildren(document.createTextNode(text));
	if (offerOpenTailscale && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "banner-action";
		btn.textContent = "Open Tailscale";
		btn.addEventListener("click", () => {
			location.href = "tailscale://";
		});
		banner.appendChild(btn);
	}
	banner.classList.add("visible");
}
async function diagnoseConnection() {
	if (!navigator.onLine) {
		setConnectionBanner("You’re offline. Reconnecting when the network returns…");
		return;
	}
	if (Date.now() - state.lastProbeAt < 1e4) {
		if (state.lastDiagnosis) setConnectionBanner(state.lastDiagnosis.text, state.lastDiagnosis.offer);
		return;
	}
	state.lastProbeAt = Date.now();
	const internetUp = await probeInternet();
	if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
	state.lastDiagnosis = internetUp ? {
		text: state.serverUsesTailscale ? "Internet is up but the server is unreachable — check that Tailscale is connected on this device." : "Internet is up but the server is unreachable — it may be down.",
		offer: state.serverUsesTailscale
	} : {
		text: "No internet connection. Reconnecting…",
		offer: false
	};
	setConnectionBanner(state.lastDiagnosis.text, state.lastDiagnosis.offer);
}
function connect() {
	if (state.ws) {
		state.ws._intentionalClose = true;
		try {
			state.ws.close();
		} catch {}
	}
	const sock = new WebSocket(getWsUrl(), getWsProtocols());
	state.ws = sock;
	sock.onopen = () => {
		$("#connection-banner")?.classList.remove("visible");
		state.reconnectDelay = 1e3;
		state.lastProbeAt = 0;
		state.lastDiagnosis = null;
		sock.send(JSON.stringify({ type: "auth" }));
	};
	sock.onmessage = (evt) => {
		const msg = JSON.parse(evt.data);
		switch (msg.type) {
			case "system":
				if (msg.message && !state.myIdentity) {
					const m = msg.message.match(/^(?:Connected as|Welcome,)\s+(.+)$/);
					if (m) state.myIdentity = m[1].trim();
				}
				appendSystem(msg.message);
				return;
			case "rooms":
				if (!state.lastRoomsList.length && msg.rooms.length) refreshDraftBadge();
				state.lastRoomsList = msg.rooms;
				msg.rooms.forEach((r) => {
					if (r.unread && r.id !== state.currentRoom) state.unreadRooms.add(r.id);
					if (r.mention && r.id !== state.currentRoom) state.mentionedRooms.add(r.id);
					else if (!r.mention) state.mentionedRooms.delete(r.id);
					else state.unreadRooms.delete(r.id);
				});
				renderRooms(msg.rooms);
				if (state.allAgents.length === 0) authFetch("/api/agents").then((r) => r.json()).then((b) => {
					state.allAgents = b;
				}).catch(() => {});
				fetchApprovals();
				fetchMyHandle();
				probeIsOwner();
				refreshWiredAgentsForCurrentRoom();
				fetchMentionablePeople();
				if (state.currentRoom) {
					state.ws?.send(JSON.stringify({
						type: "join",
						room_id: state.currentRoom
					}));
					if (state.lastSeenMessageId) authFetch(`/api/rooms/${state.currentRoom}/messages?after_id=${state.lastSeenMessageId}`).then((r) => r.json()).then((missed) => {
						if (missed.length > 0) {
							const wasNearBottom = isNearBottom();
							missed.forEach((m) => appendMessage(m));
							setLastSeenMessageId(missed[missed.length - 1].id);
							if (wasNearBottom) scrollToBottom();
							else updateScrollButton();
						}
					}).catch(() => {});
				} else {
					const saved = localStorage.getItem("lastRoom");
					if (saved) {
						const room = msg.rooms.find((r) => r.id === saved);
						if (room) {
							const savedThread = localStorage.getItem("lastThread:" + saved);
							joinRoom(room.id, room.name, void 0, savedThread && savedThread !== "main" ? savedThread : void 0);
						}
					}
				}
				break;
			case "history": {
				const room = msg.room_id || state.currentRoom;
				const carried = [];
				for (const [clientId, row] of state.pendingMessages) if (row.roomId === room && row.threadId === state.currentThread) carried.push([clientId, row]);
				setMessages([]);
				transcriptEmpty.value = null;
				msg.messages.forEach((m) => appendMessage(m));
				for (const [clientId, row] of carried) {
					if (row.id && msg.messages.some((m) => m.id === row.id)) {
						state.pendingMessages.delete(clientId);
						continue;
					}
					state.pendingMessages.set(clientId, readdRow(row));
				}
				state.oldestMessageId = msg.messages.length ? msg.messages[0].id : null;
				state.noMoreOlder = msg.messages.length < 50;
				state.loadingOlder = false;
				if (msg.messages.length === 0 && carried.length === 0) transcriptEmpty.value = "No messages yet. Start the conversation!";
				endTranscriptSwitch();
				if (msg.messages.length > 0) setLastSeenMessageId(msg.messages[msg.messages.length - 1].id);
				const sendAfter = state.pendingSendAfterJoin;
				state.pendingSendAfterJoin = null;
				if (sendAfter) triggerLearn(sendAfter);
				const jumpTo = state.pendingJumpMessageId;
				state.pendingJumpMessageId = null;
				if (jumpTo) jumpToMessage(jumpTo);
				else {
					scrollToBottom(true);
					requestAnimationFrame(() => scrollToBottom(true));
					setTimeout(() => scrollToBottom(true), 100);
					setTimeout(() => scrollToBottom(true), 300);
				}
				break;
			}
			case "members":
				if (msg.room_id === state.currentRoom) {
					renderMembers(msg.members);
					fetchMentionablePeople();
				}
				break;
			case "message": {
				if (msg.room_id && msg.created_at) {
					state.roomActivity.set(msg.room_id, Math.max(state.roomActivity.get(msg.room_id) || 0, msg.created_at));
					if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
				}
				const msgThread = msg.thread_id || "main";
				if ((msg.room_id || state.currentRoom) === state.currentRoom && msgThread !== state.currentThread) {
					if (msg.sender !== state.myIdentity) state.threadUnread.add(msgThread);
					break;
				}
				const wasNearBottom = isNearBottom();
				if (state.settings?.notifications && document.hidden && msg.sender !== state.myIdentity && msg.message_type !== "a2a" && msg.sender_type !== "a2a") try {
					const mentioned = messageMentionsMe(msg.content);
					new Notification(mentioned ? `${msg.sender} mentioned you` : `${msg.sender}`, {
						body: msg.content.slice(0, 100),
						tag: msg.id || "nanoclaw-msg",
						requireInteraction: mentioned
					});
				} catch {}
				if (msg.sender === state.myIdentity && msg.client_id && state.pendingMessages.has(msg.client_id)) {
					const row = state.pendingMessages.get(msg.client_id);
					row.status = "✓✓";
					state.pendingMessages.delete(msg.client_id);
					if (msg.id) row.id = msg.id;
				} else appendMessage(msg);
				if (msg.id && msg.room_id === state.currentRoom) {
					setLastSeenMessageId(msg.id);
					if (!document.hidden && state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({
						type: "read",
						room_id: state.currentRoom,
						thread_id: state.currentThread
					}));
				}
				if (wasNearBottom || state.forceScrollCount > 0 && !state.userScrolledAway) {
					scrollToBottom();
					requestAnimationFrame(() => {
						if (!state.userScrolledAway) scrollToBottom();
					});
					setTimeout(() => {
						if (!state.userScrolledAway) scrollToBottom();
					}, 200);
					if (state.forceScrollCount > 0) state.forceScrollCount--;
				} else incrementMissedMessages();
				break;
			}
			case "typing":
				handleTypingEvent(msg);
				break;
			case "status":
				handleStatusEvent(msg);
				break;
			case "unread":
				if (msg.room_id && msg.room_id !== state.currentRoom) {
					state.unreadRooms.add(msg.room_id);
					updateUnreadDots();
				}
				break;
			case "mention":
				if (msg.room_id && msg.room_id !== state.currentRoom) {
					state.mentionedRooms.add(msg.room_id);
					state.unreadRooms.add(msg.room_id);
					updateUnreadDots();
				}
				break;
			case "read_cleared": {
				const cleared = (msg.room_id && state.unreadRooms.delete(msg.room_id)) | 0;
				const clearedMention = (msg.room_id && state.mentionedRooms.delete(msg.room_id)) | 0;
				if (cleared || clearedMention) updateUnreadDots();
				break;
			}
			case "delete_message":
				if (msg.message_id) {
					const el = document.querySelector(`[data-message-id="${CSS.escape(msg.message_id)}"]`);
					if (el) {
						el.classList.add("deleting");
						setTimeout(() => el.remove(), 350);
					}
				}
				break;
			case "approval":
				handleApprovalEvent(msg);
				break;
			case "approval_resolved":
				handleApprovalResolvedEvent(msg);
				break;
			case "skill_draft_review":
				handleSkillDraftReview(msg);
				break;
			case "error": console.error("WS error:", msg.error);
		}
	};
	sock.onclose = () => {
		if (sock._intentionalClose) return;
		if (state.ws !== sock) return;
		setConnectionBanner("Connection lost. Reconnecting…");
		diagnoseConnection();
		state.myIdentity = "";
		setTimeout(connect, state.reconnectDelay);
		state.reconnectDelay = Math.min(state.reconnectDelay * 2, 3e4);
	};
}
async function probeInternet() {
	const hit = (url) => fetch(url, {
		mode: "no-cors",
		cache: "no-store",
		signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(4e3) : void 0
	});
	try {
		await Promise.any([hit("https://derp1.tailscale.com/generate_204"), hit("https://www.gstatic.com/generate_204")]);
		return true;
	} catch {
		return false;
	}
}
function setLastSeenMessageId(id) {
	state.lastSeenMessageId = id;
	if (id) sessionStorage.setItem("lastSeenMessageId", id);
}
var TOOL_LABELS = {
	Bash: "Running command",
	Read: "Reading file",
	Write: "Writing file",
	Edit: "Editing file",
	Glob: "Searching files",
	Grep: "Searching code",
	WebSearch: "Searching the web",
	WebFetch: "Fetching page",
	Task: "Managing tasks",
	NotebookEdit: "Editing notebook"
};
var LEARN_NUDGE_MIN_TOOLS = 5;
async function fetchMyHandle() {
	try {
		const r = await authFetch("/api/me/handle");
		if (r.ok) state.myHandle = ((await r.json()).handle || "").toLowerCase();
	} catch {}
	renderHandleChip();
}
async function probeIsOwner() {
	try {
		const [check, users] = await Promise.all([authFetch("/api/auth/check"), authFetch("/api/users")]);
		if (check.ok) {
			const body = await check.json();
			if (body && typeof body.userId === "string") permsMyUserId.value = body.userId;
		}
		if (users.ok) {
			$("#overflow-permissions").hidden = false;
			$("#overflow-admin").hidden = false;
			$("#overflow-journey")?.removeAttribute("hidden");
			isAdminView.value = true;
			try {
				const fr = await authFetch("/api/webchat/features");
				const feats = fr.ok ? await fr.json() : {};
				state.marketplaceEnabled = feats.marketplaceEnabled === true;
				renderCredentialIsolation(feats);
			} catch {
				state.marketplaceEnabled = false;
			}
			if (state.marketplaceEnabled) {
				$("#overflow-mcp")?.removeAttribute("hidden");
				$("#mtab-mcp-btn")?.removeAttribute("hidden");
				$("#mtab-skills-btn")?.removeAttribute("hidden");
				$("#overflow-skills")?.removeAttribute("hidden");
			}
			const list = await users.json().catch(() => []);
			const me = Array.isArray(list) ? list.find((u) => u.id === permsMyUserId.value) : null;
			state.isOwnerView = !!(me && userIsOwner(me));
			return true;
		}
	} catch {}
	state.isOwnerView = false;
	isAdminView.value = false;
	return false;
}
function handleStatusEvent(msg) {
	if (msg.room_id !== state.currentRoom) return;
	const name = msg.agent_name || state.agentName || "Agent";
	switch (msg.event) {
		case "start":
			beginAgentTurn(name);
			learnTurnToolCount.value = 0;
			break;
		case "tool":
			markTurnActivity(name);
			learnTurnToolCount.value++;
			updateThinkingBubble(name, msg.text ? TOOL_LABELS[msg.text] || `Using ${msg.text}` : "Working", msg.detail || null);
			break;
		case "progress":
			markTurnActivity(name);
			if (msg.text) setThinkingMilestone(name, msg.text);
			break;
		case "reasoning":
			markTurnActivity(name);
			if (msg.text) pushReasoning(name, msg.text);
			break;
		case "done":
			endAgentTurn(name);
			if (learnTurnToolCount.value >= LEARN_NUDGE_MIN_TOOLS && roomAutoLearn.get(state.currentRoom ?? "") !== true) showLearnNudge();
			learnTurnToolCount.value = 0;
			break;
		case "stalled":
			endAgentTurn(name);
			appendSystem(msg.text || "The agent stopped responding. You may want to resend your message.");
	}
}
//#endregion
//#region src/boot.ts
/**
* On returning to a visible tab: reconnect if the socket dropped, otherwise
* refresh approvals and advance the read marker for the open room.
*/
function wireVisibilityRefresh() {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		if (state.ws && state.ws.readyState !== WebSocket.OPEN) connect();
		else {
			fetchApprovals();
			if (state.currentRoom) state.ws?.send(JSON.stringify({
				type: "read",
				room_id: state.currentRoom,
				thread_id: state.currentThread
			}));
		}
	});
	window.addEventListener("online", () => {
		if (state.ws && state.ws.readyState !== WebSocket.OPEN) {
			state.reconnectDelay = 1e3;
			connect();
		}
	});
	window.addEventListener("offline", () => {
		if (state.ws && state.ws.readyState !== WebSocket.OPEN) diagnoseConnection();
	});
}
/**
* The manage-view tab strip. Static markup, so this binds once at boot.
*/
function wireManageTabs() {
	document.querySelectorAll(".manage-tab").forEach((t) => {
		t.addEventListener("click", () => switchManageTab(t.dataset.mtab));
	});
	/**
	* Minimal LCS line diff. A revision is only reviewable if you can see what
	* CHANGED — showing the whole new file and asking someone to spot the edit is not
	* review, it's proofreading. Skills are small, so O(m×n) is fine and beats pulling
	* in a diff dependency.
	*/
}
/**
* Service-worker registration and the update banner.
*
* Composition-level, like everything else here: it registers the worker, polls
* for updates, and drives the banner that offers a reload. It touches
* #update-banner and the login screen, which belong to the app shell rather
* than to any panel — which is why the ownership heuristic reported it as
* "auth+files+learn+rooms+voice" and why none of those is right.
*/
function wireServiceWorker(hasStagedFile) {
	if ("serviceWorker" in navigator) {
		let swReg = null;
		const checkForUpdate = () => swReg && swReg.update().catch(() => {});
		navigator.serviceWorker.register("/sw.js").then((reg) => {
			if (!reg) return;
			swReg = reg;
			reg.update().catch(() => {});
			setInterval(checkForUpdate, 6e4);
			reg.addEventListener("updatefound", () => {
				const nw = reg.installing;
				if (nw) nw.addEventListener("statechange", () => {
					if (nw.state === "installed" && navigator.serviceWorker.controller) tryReload();
				});
			});
		});
		let refreshing = false;
		let reloadPending = false;
		function safeToReload() {
			const input = document.getElementById("message-input");
			const hasDraft = input && input.value.trim().length > 0;
			const staged = hasStagedFile();
			if (hasDraft || staged) return false;
			const loginScreen = document.getElementById("login-screen");
			const tokenField = document.getElementById("login-token");
			const onLogin = loginScreen && !loginScreen.hidden;
			const typingToken = tokenField && tokenField.value.trim().length > 0;
			if (onLogin && !typingToken) return true;
			return document.hidden;
		}
		function tryReload() {
			if (refreshing) return;
			if (safeToReload()) {
				refreshing = true;
				location.reload();
			} else {
				reloadPending = true;
				showUpdateBanner();
			}
		}
		function showUpdateBanner() {
			if (document.getElementById("update-banner")) return;
			const b = document.createElement("button");
			b.id = "update-banner";
			b.type = "button";
			b.className = "update-banner";
			b.textContent = "A new version is ready — tap to refresh";
			b.addEventListener("click", () => {
				refreshing = true;
				location.reload();
			});
			document.body.appendChild(b);
		}
		document.addEventListener("visibilitychange", () => {
			if (document.hidden) {
				if (reloadPending) tryReload();
			} else checkForUpdate();
		});
		navigator.serviceWorker.addEventListener("controllerchange", () => {
			tryReload();
		});
		navigator.serviceWorker.addEventListener("message", (e) => {
			if (e.data && e.data.type === "open-room" && e.data.roomId) {
				const agent = state.allAgents.find((b) => b.room_id === e.data.roomId);
				joinRoom(e.data.roomId, agent?.name || e.data.roomId);
			}
		});
		const coldRoom = new URLSearchParams(location.search).get("room");
		if (coldRoom) {
			const tryJoin = () => {
				const agent = state.allAgents.find((b) => b.room_id === coldRoom);
				if (state.allAgents.length) joinRoom(coldRoom, agent?.name || coldRoom);
				else setTimeout(tryJoin, 200);
			};
			tryJoin();
		}
	}
}
async function copyTextToClipboard(text) {
	if (navigator.clipboard && window.isSecureContext) try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {}
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.body.removeChild(ta);
	return ok;
}
/**
* Code-block Wrap/Copy used to be delegated from #messages: one click handler
* that found the button, wrote its label and toggled its classes. CodeToolbar
* owns both buttons and both pieces of feedback now, so there is nothing left
* to delegate — see features/CodeToolbar.vue.
*/
/** Mobile back affordance: leaves the in-room layout. */
function wireMobileBack() {
	$("#mobile-back")?.addEventListener("click", () => {
		$("#app")?.classList.remove("in-room");
	});
}
/** Composer paste: long text becomes an attachment; files fall through
* to the drop handler. */
function wireComposerPaste() {
	$("#message-input")?.addEventListener("paste", (e) => {
		if (e.clipboardData?.files?.length) return;
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (!text.includes("\n")) return;
		e.preventDefault();
		const input = e.currentTarget;
		const longestTicks = (text.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
		const fence = "`".repeat(Math.max(3, longestTicks + 1));
		const before = input.value.slice(0, input.selectionStart);
		const insert = `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}${fence}\n${text.replace(/\n+$/, "")}\n${fence}\n`;
		const valBefore = input.value;
		document.execCommand("insertText", false, insert);
		if (input.value === valBefore) {
			input.setRangeText(insert, input.selectionStart, input.selectionEnd, "end");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
}
var detailRouterOpen = false;
var afterDetailClose = null;
function closeAllDetailDrawers() {
	for (const id of [
		"#agent-detail",
		"#room-detail",
		"#model-detail",
		"#mcp-detail"
	]) {
		const el = $(id);
		if (el) el.hidden = true;
	}
}
/** Whether a detail drawer currently owns the top view-stack entry. */
function getDetailRouterOpen() {
	return detailRouterOpen;
}
/** A deferred full-view open, run once the drawer's route has popped. */
function getAfterDetailClose() {
	return afterDetailClose;
}
function setAfterDetailClose(fn) {
	afterDetailClose = fn;
}
/** The shared detail backdrop: closes whichever drawer is open, and routes back. */
function wireDetailOverlay() {
	const overlay = $("#detail-overlay");
	if (!overlay) return;
	const panels = [
		"#agent-detail",
		"#room-detail",
		"#model-detail",
		"#mcp-detail"
	].map((sel) => $(sel)).filter((el) => el !== null);
	const app = $("#app");
	const sync = () => {
		const allHidden = panels.every((p) => p.hidden);
		overlay.hidden = allHidden;
		if (app) app.classList.toggle("detail-open", !allHidden);
		if (!allHidden && !detailRouterOpen) {
			detailRouterOpen = true;
			openView("detail", () => {
				detailRouterOpen = false;
				closeAllDetailDrawers();
				const next = afterDetailClose;
				afterDetailClose = null;
				if (next) queueMicrotask(next);
			});
		} else if (allHidden && detailRouterOpen) {
			detailRouterOpen = false;
			closeView("detail");
		}
	};
	const obs = new MutationObserver(sync);
	for (const p of panels) obs.observe(p, {
		attributes: true,
		attributeFilter: ["hidden"]
	});
	sync();
	overlay.addEventListener("click", () => {
		if (!$("#agent-detail")?.hidden) closeAgentDetail();
		if (!$("#room-detail")?.hidden) closeRoomDetail();
		if (!$("#model-detail")?.hidden) closeModelDetail();
		if (!$("#mcp-detail")?.hidden) closeMcpDetail();
	});
}
function wireSortToggle(btnId, storageKey, isOn, setOn, rerender) {
	const btn = $(btnId);
	if (!btn) return;
	const sync = () => {
		btn.classList.toggle("active", isOn());
		btn.setAttribute("aria-pressed", isOn() ? "true" : "false");
	};
	sync();
	btn.addEventListener("click", () => {
		setOn(!isOn());
		sessionStorage.setItem(storageKey, isOn() ? "1" : "0");
		sync();
		rerender();
	});
}
async function clearBadgeCount() {
	try {
		const db = await new Promise((resolve, reject) => {
			const r = indexedDB.open("nanoclaw-badge", 1);
			r.onupgradeneeded = () => r.result.createObjectStore("state");
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
		await new Promise((resolve) => {
			const tx = db.transaction("state", "readwrite");
			tx.objectStore("state").put(0, "count");
			tx.oncomplete = () => resolve();
		});
	} catch {}
	if ("clearAppBadge" in navigator) try {
		await navigator.clearAppBadge();
	} catch {}
}
//#endregion
//#region src/features/admin.ts
/**
* Hide a group whose every block hid itself.
*
* Without this a scoped admin sees "Setup", "Access & credentials" and
* "Policy" as headings over empty space — the page would advertise exactly
* what they are not allowed to do. Same argument as syncFeaturesColumn in
* settings.ts, and the same shape: ask the rendered children, do not try to
* re-derive the permission rule here. A second source of truth for who may
* see what is how the gates drifted apart the last three times.
*/
function syncAdminGroups() {
	for (const group of document.querySelectorAll("#admin .admin-group")) {
		const blocks = group.querySelectorAll(".settings-credentials, .settings-feature");
		group.hidden = blocks.length > 0 && [...blocks].every((b) => b.hasAttribute("hidden"));
	}
}
function openAdmin() {
	openFullView(() => {
		hideOtherFullViews("admin");
		adminActive.value = true;
		$("#chat").hidden = true;
		$("#admin").hidden = false;
		$("#overflow-btn")?.classList.add("active");
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		renderSettingsWizardButton();
		renderCredentialsSettings();
		renderPrejudgeSettings();
		renderBackupSettings();
		Promise.allSettled([
			renderSelfTest(),
			renderAccessSettings(),
			renderToolSecrets(),
			renderAutoLearnSetting(),
			renderAuditSettings(),
			renderAboutSettings()
		]).then(syncAdminGroups);
		openView("admin", teardownAdmin);
	});
}
function teardownAdmin() {
	adminActive.value = false;
	$("#chat").hidden = false;
	$("#admin").hidden = true;
	$("#overflow-btn")?.classList.remove("active");
	$("#app").classList.remove("in-dashboard");
}
function toggleAdmin() {
	if (adminActive.value) closeView("admin");
	else openAdmin();
}
//#endregion
//#region src/features/perms-audit.ts
function findRole(u, kind, agentGroupId) {
	return u.roles.find((r) => r.kind === kind && r.agent_group_id === agentGroupId);
}
function auditTooltip(audit) {
	if (!audit) return "";
	const who = audit.granted_by || audit.added_by || "system";
	const whenIso = audit.granted_at || audit.added_at || "";
	const when = whenIso ? new Date(whenIso).toLocaleString() : "";
	return `Granted by ${who}${when ? " on " + when : ""}`;
}
//#endregion
//#region src/features/PermsGlobalToggles.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1$1 = { class: "perms-toggle-label" };
var _hoisted_2$1 = {
	key: 0,
	class: "perms-toggle-meta"
};
var _hoisted_3$1 = [
	"aria-checked",
	"aria-label",
	"onClick"
];
//#endregion
//#region src/features/PermsGlobalToggles.vue
var PermsGlobalToggles_default = /* @__PURE__ */ defineComponent({
	__name: "PermsGlobalToggles",
	props: { onToggle: { type: Function } },
	setup(__props) {
		/**
		* The Owner / Global-admin switches — twelfth island.
		*
		* Mounted into <div id="perms-global-toggles">, exclusively owned by this
		* module.
		*
		* This one absorbs a legacy function rather than calling it. buildToggleRow()
		* lived in legacy.js and built these rows imperatively; it was used by nothing
		* except renderPermsDetail, and it is pure markup plus one click handler. A
		* component that received DOM nodes from a legacy builder would be a component
		* in name only — so the markup moved into this template and the legacy function
		* is deleted in the same commit, along with its dep entry.
		*
		* The audit metadata is deliberately rendered twice over: the label carries
		* "(Granted by …)" as visible text, exactly as the imperative row did. It is
		* not a title attribute here — that is the matrix, which is a different island
		* and a different affordance.
		*/
		const props = __props;
		/** [label, prefix, role kind] — the two global roles, in display order. */
		const ROWS = [[
			"Owner",
			"👑 ",
			"owner"
		], [
			"Global admin",
			"",
			"admin"
		]];
		const rows = computed(() => ROWS.map(([label, prefix, kind]) => {
			const audit = permsDetailUser.value ? findRole(permsDetailUser.value, kind, null) : null;
			return {
				kind,
				label,
				text: `${prefix}${label}`,
				audit,
				meta: audit ? `(${auditTooltip(audit)})` : ""
			};
		}));
		return (_ctx, _cache) => {
			return openBlock(true), createElementBlock(Fragment, null, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("div", {
					key: r.kind,
					class: "perms-toggle-row"
				}, [createElementVNode("span", _hoisted_1$1, [createTextVNode(toDisplayString(r.text), 1), r.audit ? (openBlock(), createElementBlock("span", _hoisted_2$1, toDisplayString(r.meta), 1)) : createCommentVNode("", true)]), createElementVNode("button", {
					type: "button",
					class: normalizeClass(`perms-switch${r.audit ? " on" : ""}`),
					role: "switch",
					"aria-checked": r.audit ? "true" : "false",
					"aria-label": r.label,
					onClick: ($event) => props.onToggle(r.kind, !r.audit)
				}, null, 10, _hoisted_3$1)]);
			}), 128);
		};
	}
});
//#endregion
//#region src/features/PermsMatrix.vue?vue&type=script&setup=true&lang.ts
var _hoisted_1 = {
	key: 0,
	class: "perms-matrix-empty"
};
var _hoisted_2 = ["title"];
var _hoisted_3 = ["aria-label", "onClick"];
var _hoisted_4 = ["aria-label", "onClick"];
var EMPTY = "No agent groups yet.";
//#endregion
//#region src/features/PermsMatrix.vue
var PermsMatrix_default = /* @__PURE__ */ defineComponent({
	__name: "PermsMatrix",
	props: { onToggle: { type: Function } },
	setup(__props) {
		/**
		* The per-agent-group permission matrix — thirteenth island.
		*
		* Mounted into <div id="perms-matrix">, exclusively owned by this module.
		*
		* Two cells per group, admin and member, each a tap-to-toggle button. The
		* `busy` class the click handler adds is NOT modelled here: togglePerm() adds
		* it to the clicked element and removes it when the request settles, and it
		* survives because the row is not re-rendered in between — refreshPermissions()
		* only runs after the class is already off again. Modelling it as state would
		* mean threading a per-cell pending flag for a class nothing reads.
		*
		* `title` is set only when there IS an audit record, matching the imperative
		* version's `if (adminRole) adminBtn.title = …`. An unconditional :title would
		* emit title="" on every ungranted cell, which is the same class of difference
		* as the :class="{active:false}" one from the first island.
		*/
		const props = __props;
		const rows = computed(() => {
			const u = permsDetailUser.value;
			if (!u) return [];
			return permsAgents.value.map((a) => {
				const adminRole = findRole(u, "admin", a.id);
				const member = findMembership(u, a.id);
				const name = a.name || a.id;
				return {
					id: a.id,
					name,
					adminRole,
					member,
					adminLabel: `${adminRole ? "Revoke" : "Grant"} admin · ${name}`,
					memberLabel: `${member ? "Revoke" : "Grant"} member · ${name}`
				};
			});
		});
		function toggle(kind, agentGroupId, granting, e) {
			props.onToggle(kind, agentGroupId, granting, e.currentTarget);
		}
		return (_ctx, _cache) => {
			return rows.value.length === 0 ? (openBlock(), createElementBlock("div", _hoisted_1, toDisplayString(EMPTY))) : (openBlock(true), createElementBlock(Fragment, { key: 1 }, renderList(rows.value, (r) => {
				return openBlock(), createElementBlock("div", {
					key: r.id,
					class: "perms-matrix-row"
				}, [
					createElementVNode("span", {
						class: "perms-group-name",
						title: r.id
					}, toDisplayString(r.name), 9, _hoisted_2),
					createElementVNode("button", mergeProps({
						type: "button",
						class: `perms-cell${r.adminRole ? " on" : ""}`
					}, { ref_for: true }, r.adminRole ? { title: unref(auditTooltip)(r.adminRole) } : {}, {
						"aria-label": r.adminLabel,
						onClick: ($event) => toggle("admin", r.id, !r.adminRole, $event)
					}), toDisplayString(r.adminRole ? "✓" : "·"), 17, _hoisted_3),
					createElementVNode("button", mergeProps({
						type: "button",
						class: `perms-cell member-style${r.member ? " on" : ""}`
					}, { ref_for: true }, r.member ? { title: unref(auditTooltip)(r.member) } : {}, {
						"aria-label": r.memberLabel,
						onClick: ($event) => toggle("member", r.id, !r.member, $event)
					}), toDisplayString(r.member ? "✓" : "·"), 17, _hoisted_4)
				]);
			}), 128));
		};
	}
});
//#endregion
//#region src/features/auth.ts
var deps$1 = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function provideAuthDeps(provided) {
	Object.assign(deps$1, provided);
}
async function checkAuth() {
	if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "ok";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const headers = getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {};
			const res = await fetch("/api/auth/check", {
				headers,
				cache: "no-store"
			});
			if (res.ok) return "ok";
			if (res.status === 401 || res.status === 403) return "unauthenticated";
		} catch {}
		if (!navigator.onLine) break;
		await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
	}
	return "unreachable";
}
async function reprobeAuthWhenOnline() {
	if (!navigator.onLine) await new Promise((r) => window.addEventListener("online", r, { once: true }));
	if (await checkAuth() !== "unauthenticated") return;
	$("#login-screen").hidden = false;
	$("#app").hidden = true;
	applyLoginHint();
}
function enterAuthedApp() {
	$("#login-screen").hidden = true;
	$("#app").hidden = false;
	connect();
	cacheAuthHint();
	if (state.settings?.notifications && typeof Notification !== "undefined" && Notification.permission === "granted") enableWebPush();
	maybeAutoOpenWizard();
	maybeSuggestBearerRetire();
	initSttFeature();
	loadLearningMaster();
	loadTtsConfig();
}
var bearerRetireWired = false;
async function maybeSuggestBearerRetire() {
	const banner = $("#bearer-retire-banner");
	if (!banner) return;
	if (localStorage.getItem("nanoclaw-bearer-retire-dismissed") === "1") return;
	let info = null;
	try {
		const r = await authFetch("/api/webchat/auth");
		if (r.ok) info = await r.json();
	} catch {
		info = null;
	}
	if (!info || !info.bearerActive || !info.canDisableBearer || info.sessionSource === "bearer") return;
	if (!bearerRetireWired) {
		bearerRetireWired = true;
		$("#bearer-retire-disable")?.addEventListener("click", () => retireBearerFromBanner());
		$("#bearer-retire-dismiss")?.addEventListener("click", () => {
			localStorage.setItem("nanoclaw-bearer-retire-dismissed", "1");
			banner.hidden = true;
		});
	}
	banner.hidden = false;
}
async function retireBearerFromBanner() {
	const banner = $("#bearer-retire-banner");
	const btn = $("#bearer-retire-disable");
	if (btn) btn.disabled = true;
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: false })
		});
		const data = await r.json().catch(() => ({}));
		if (r.ok) {
			showToast("Bearer token disabled — access is via Tailscale/SSO", { kind: "success" });
			localStorage.setItem("nanoclaw-bearer-retire-dismissed", "1");
			if (banner) banner.hidden = true;
		} else showToast(data.error || "Could not disable the bearer token", {
			kind: "error",
			timeout: 8e3
		});
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		if (btn) btn.disabled = false;
	}
}
async function cacheAuthHint() {
	try {
		const r = await fetch("/api/auth/info");
		if (r.ok) rememberServerAuthHint((await r.json()).methods);
	} catch {}
}
async function applyLoginHint() {
	let info;
	try {
		const r = await fetch("/api/auth/info");
		if (!r.ok) return;
		info = await r.json();
	} catch {
		return;
	}
	const subtitle = $(".login-subtitle");
	subtitle.hidden = false;
	const m = info.methods || {};
	rememberServerAuthHint(m);
	if (!m.bearer) $("#login-form").hidden = true;
	if (m.tailscale && info.tailscaleHealthy) subtitle.textContent = "Tailscale should sign you in automatically — make sure it’s running on this device, then refresh.";
	else if (m.tailscale && !info.tailscaleHealthy) subtitle.hidden = true;
	else if (m.proxy && !m.bearer) subtitle.innerHTML = "Couldn't sign you in — your reverse proxy didn't pass an identity through. Try refreshing, or ask whoever sent you the link.";
	else if (m.bearer) subtitle.textContent = "Enter the access token you were given below.";
	else {
		subtitle.textContent = "This server isn't ready to sign anyone in yet. Whoever installed it needs to finish setup.";
		$("#login-form").hidden = true;
	}
}
async function toggleBearerToken(wantActive) {
	const btn = $("#access-bearer-btn");
	const hint = $("#access-bearer-hint");
	if (!wantActive && btn.dataset.confirming !== "1") {
		btn.dataset.confirming = "1";
		const restore = btn.textContent;
		btn.textContent = "Click again to disable";
		bearerConfirmTimer.value = setTimeout(() => {
			btn.dataset.confirming = "";
			btn.textContent = restore;
		}, 4e3);
		return;
	}
	clearTimeout(bearerConfirmTimer.value ?? void 0);
	btn.dataset.confirming = "";
	btn.disabled = true;
	try {
		const r = await authFetch("/api/webchat/auth/bearer", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({ active: wantActive })
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok) {
			showToast(data.error || "Could not change the bearer setting", {
				kind: "error",
				timeout: 8e3
			});
			if (data.error) {
				hint.hidden = false;
				hint.textContent = data.error;
			}
		} else showToast(wantActive ? "Bearer token re-enabled" : "Bearer token disabled — access is via Tailscale/SSO", { kind: "success" });
	} catch {
		showToast("Connection failed", { kind: "error" });
	} finally {
		btn.disabled = false;
		renderAccessSettings();
	}
}
var serverAuthMethods = null;
async function ensureServerAuthMethods() {
	if (serverAuthMethods) return serverAuthMethods;
	try {
		const r = await fetch("/api/auth/info");
		if (r.ok) serverAuthMethods = (await r.json()).methods || null;
	} catch {}
	return serverAuthMethods;
}
function applyCreateAuthDefault() {
	const m = serverAuthMethods || {};
	if (!permsCreateChannelTouched.value) $("#perms-create-channel").value = m.tailscale ? "webchat:tailscale" : "webchat";
	const hint = $("#perms-create-method-hint");
	if (m.tailscale) hint.textContent = "This install signs people in via Tailscale — they appear as webchat:tailscale:<email>.";
	else if (m.proxy) hint.textContent = "This install signs people in via SSO / reverse proxy (e.g. Entra ID) — they appear as webchat:<email>.";
	else if (m.bearer) hint.textContent = "This install uses a shared bearer token — per-user ids only differ when a proxy or Tailscale also fronts it.";
	else hint.textContent = "";
	deps$1.permsRefreshCreateUI();
}
/** The login form's only error surface — guarded once instead of at four sites. */
function showLoginError(message) {
	const el = $("#login-error");
	if (!el) return;
	el.textContent = message;
	el.hidden = false;
}
function wireAuthPanel() {
	const tokenInput = $("#login-token");
	$("#login-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const token = tokenInput?.value.trim() ?? "";
		if (!token) return;
		try {
			if ((await fetch("/api/auth/check", { headers: { Authorization: `Bearer ${token}` } })).ok) {
				setAuthToken(token);
				sessionStorage.setItem("nanoclaw-token", token);
				enterAuthedApp();
			} else showLoginError("Invalid token");
		} catch {
			showLoginError("Connection failed");
		}
	});
}
//#endregion
//#region src/features/perms.ts
var deps = {};
/** Wire the legacy helpers this module calls. Call once at startup. */
function providePermsDeps(provided) {
	Object.assign(deps, provided);
}
function openPermissions() {
	openFullView(() => {
		hideOtherFullViews("permissions");
		permsActive.value = true;
		$("#chat").hidden = true;
		$("#permissions").hidden = false;
		$("#overflow-btn")?.classList.add("active");
		$("#app").classList.add("in-dashboard");
		$("#app").classList.remove("in-room");
		permsShowList();
		refreshPermissions();
		openView("permissions", teardownPermissions);
	});
}
function teardownPermissions() {
	permsActive.value = false;
	$("#chat").hidden = false;
	$("#permissions").hidden = true;
	$("#overflow-btn")?.classList.remove("active");
	$("#app").classList.remove("in-dashboard");
}
function togglePermissions() {
	if (permsActive.value) closeView("permissions");
	else openPermissions();
}
async function refreshPermissions() {
	try {
		const [usersRes, agentsRes] = await Promise.all([authFetch("/api/users"), authFetch("/api/agents")]);
		if (!usersRes.ok) {
			showPermsUsersError("Failed to load users.");
			return;
		}
		permsUsers.value = await usersRes.json();
		permsAgents.value = agentsRes.ok ? await agentsRes.json() : [];
		populatePermsAgentDropdowns();
		renderPermsUserList();
		if (permsSelectedUserId.value && permsUsers.value.find((u) => u.id === permsSelectedUserId.value)) renderPermsDetail(permsSelectedUserId.value);
		else if (permsSelectedUserId.value) {
			permsSelectedUserId.value = null;
			permsShowList();
		}
	} catch (err) {
		console.error("refreshPermissions failed:", err);
	}
}
var globalTogglesApp = null;
var matrixApp = null;
function mountPermsDetail() {
	if (!globalTogglesApp) {
		const host = $("#perms-global-toggles");
		if (host) {
			globalTogglesApp = createApp(PermsGlobalToggles_default, { onToggle: (kind, granting) => {
				const u = permsDetailUser.value;
				if (u) togglePerm(u.id, kind, null, granting);
			} });
			globalTogglesApp.mount(host);
		}
	}
	if (!matrixApp) {
		const host = $("#perms-matrix");
		if (host) {
			matrixApp = createApp(PermsMatrix_default, { onToggle: (kind, agentGroupId, granting, el) => {
				const u = permsDetailUser.value;
				if (u) togglePerm(u.id, kind, agentGroupId, granting, el);
			} });
			matrixApp.mount(host);
		}
	}
}
function renderPermsDetail(userId) {
	const u = permsUsers.value.find((x) => x.id === userId);
	if (!u) return;
	$("#perms-detail-name").textContent = userDisplayName(u);
	$("#perms-detail-id").textContent = u.id;
	permsDetailUser.value = u;
	mountPermsDetail();
	const deleteZone = $("#perms-delete-zone");
	const deleteBtn = $("#perms-delete-btn");
	const isSelf = u.id === permsMyUserId.value;
	const hasRolesOrMemberships = u.roles.length > 0 || u.memberships.length > 0;
	if (deleteZone) {
		deleteZone.hidden = isSelf;
		if (deleteBtn) {
			deleteBtn.disabled = hasRolesOrMemberships;
			deleteBtn.title = hasRolesOrMemberships ? "Revoke all roles and memberships before deleting" : "";
		}
	}
}
async function togglePerm(targetUserId, kind, agentGroupId, granting, cellEl) {
	if (cellEl) cellEl.classList.add("busy");
	const ok = granting ? await grantPerm(targetUserId, kind, agentGroupId) : await revokePermSilent(targetUserId, kind, agentGroupId);
	if (cellEl) cellEl.classList.remove("busy");
	if (ok) await refreshPermissions();
}
async function revokePermSilent(targetUserId, kind, agentGroupId) {
	try {
		const r = await authFetch("/api/permissions/revoke", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				userId: targetUserId,
				kind,
				agentGroupId
			})
		});
		if (!r.ok) {
			showToast("Revoke failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return false;
		}
		return true;
	} catch (err) {
		showToast("Revoke failed: " + err?.message, { kind: "error" });
		return false;
	}
}
function permsShowList() {
	$("#perms-body").dataset.mode = "list";
	$("#perms-detail-empty").hidden = false;
	$("#perms-detail-view").hidden = true;
	$("#perms-create-view").hidden = true;
}
function permsShowDetail() {
	$("#perms-body").dataset.mode = "detail";
	$("#perms-detail-empty").hidden = true;
	$("#perms-detail-view").hidden = false;
	$("#perms-create-view").hidden = true;
}
function permsShowCreate() {
	$("#perms-body").dataset.mode = "detail";
	$("#perms-detail-empty").hidden = true;
	$("#perms-detail-view").hidden = true;
	$("#perms-create-view").hidden = false;
	permsCreateChannelTouched.value = false;
	$("#perms-create-handle").value = "";
	$("#perms-create-raw").value = "";
	$("#perms-create-kind").value = "member";
	$("#perms-create-group").value = "";
	const me = permsUsers.value.find((u) => u.id === permsMyUserId.value);
	const canGrantRoles = !!(me && userIsOwner(me));
	const kindSel = $("#perms-create-kind");
	if (kindSel) {
		kindSel.querySelectorAll("option").forEach((opt) => {
			opt.hidden = !canGrantRoles && opt.value !== "member";
		});
		if (!canGrantRoles) kindSel.value = "member";
	}
	applyCreateAuthDefault();
	ensureServerAuthMethods().then(applyCreateAuthDefault);
	$("#perms-create-handle").focus();
}
async function grantPerm(targetUserId, kind, agentGroupId) {
	try {
		const r = await authFetch("/api/permissions/grant", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webchat-CSRF": "1"
			},
			body: JSON.stringify({
				userId: targetUserId,
				kind,
				agentGroupId
			})
		});
		if (!r.ok) {
			showToast("Grant failed: " + ((await r.json().catch(() => ({}))).error || r.statusText), { kind: "error" });
			return false;
		}
		return true;
	} catch (err) {
		showToast("Grant failed: " + err?.message, { kind: "error" });
		return false;
	}
}
function permsCreateComposedId() {
	const channel = $("#perms-create-channel").value;
	if (channel === "__raw__") return $("#perms-create-raw").value.trim();
	let handle = $("#perms-create-handle").value.trim();
	if (!handle) return "";
	if (channel === "webchat" || channel.startsWith("webchat:")) handle = normalizeWebchatHandle(handle);
	return `${channel}:${handle}`;
}
function permsRefreshCreateUI() {
	const isRaw = $("#perms-create-channel").value === "__raw__";
	$("#perms-create-handle-label").hidden = isRaw;
	$("#perms-create-raw-label").hidden = !isRaw;
	const composed = permsCreateComposedId();
	$("#perms-create-preview").textContent = composed ? `Resolved id: ${composed}` : "Resolved id will appear here.";
	const kind = $("#perms-create-kind").value;
	const wantsGroup = kind === "admin" || kind === "member";
	$("#perms-create-group-label").hidden = !wantsGroup;
}
/** The permissions create form. */
function wirePermsCreate() {
	$("#perms-create-form")?.addEventListener("submit", async (e) => {
		e.preventDefault();
		const userId = permsCreateComposedId();
		if (!userId) {
			showToast("Enter a handle / email (or pick \"raw user_id\" and enter the full id).", { kind: "error" });
			return;
		}
		if (!userId.includes(":")) {
			showToast("user_id must be namespaced (channel:handle).", { kind: "error" });
			return;
		}
		const kind = $("#perms-create-kind")?.value ?? "";
		const agentGroupId = ($("#perms-create-group")?.value ?? "") || null;
		if (kind === "owner" && agentGroupId) {
			showToast("owner role is always global — pick \"— global —\".", { kind: "error" });
			return;
		}
		if (kind === "member" && !agentGroupId) {
			showToast("member role requires an agent group.", { kind: "error" });
			return;
		}
		if (await grantPerm(userId, kind, agentGroupId)) {
			permsSelectedUserId.value = userId;
			await refreshPermissions();
			permsShowDetail();
		}
	});
}
/** The "new permission" button. */
function wirePermsNew() {
	$("#perms-new-btn")?.addEventListener("click", () => {
		permsSelectedUserId.value = null;
		$("#perms-user-list")?.querySelectorAll("li").forEach((li) => li.classList.remove("active"));
		permsShowCreate();
	});
}
function normalizeWebchatHandle(raw) {
	return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, "-");
}
//#endregion
//#region src/composition-root.ts
marked.setOptions({
	breaks: true,
	gfm: true
});
/**
* Three outcomes, not two: 'ok' | 'unauthenticated' | 'unreachable'.
*
* The distinction is the whole point. The service worker caches the app shell
* and serves it cache-first, so the PWA boots fine with no network at all — but
* `/api/` deliberately bypasses the SW, so this probe goes straight to the
* network. On a cold start (app launched from the home screen, radio still
* waking, VPN/Tailscale not up yet, host mid-restart) it can fail while the user
* is perfectly authenticated. Treating that as "unauthenticated" is what shows
* the token screen to someone who never needed it — and why a hard refresh
* "fixes" it: the retry simply succeeds.
*
* So: only a real auth verdict (401/403) sends anyone to the login screen.
* Anything else retries briefly, then defers to the WebSocket reconnect logic
* and the connection banner, which already handle being offline gracefully.
*/
/**
* We entered the app without a verdict (see checkAuth). Once the network is
* genuinely back, settle it: a real 401/403 means show the login screen after
* all. Runs at most once, and only while still on the optimistic path.
*/
async function initApp() {
	const verdict = await checkAuth();
	if (verdict === "ok" || verdict === "unreachable") {
		enterAuthedApp();
		if (verdict === "unreachable") reprobeAuthWhenOnline();
	} else {
		$("#login-screen").hidden = false;
		$("#app").hidden = true;
		applyLoginHint();
	}
}
/**
* Fetch `/api/auth/info` and rewrite the login subtitle so the user knows
* what's expected (Tailscale on this device vs token entry vs server
* misconfig) instead of facing a generic token prompt.
*
* The common failure mode is the client device (this phone / laptop) not
* having Tailscale running — the server's almost always fine because the
* operator had to install Tailscale to set up this server in the first
* place. The copy reflects that.
*/
wireAuthPanel();
state.settings = loadSettings();
/**
* Credential isolation — an install policy, shown only to someone who can change
* it. `credentialIsolation` is null when no choice has been made here, in which
* case .env decides and the row says so; the toggle still reflects what is
* actually in force (`credentialIsolationEffective`) so it never contradicts
* the agent panel's "Not private yet" note.
*/
$("#wizard-opencode-install")?.addEventListener("click", () => runOpencodeInstall(OPENCODE_WIZARD_ELS));
/**
* Reflect live credential state on the engine list: connected engines swap
* their connect controls for a prominent ✓ card (standard OAuth-connect UX —
* the action you completed disappears), and the radio chips update without a
* wizard reopen. Also greys Codex out when its provider isn't installed.
*/
/** Reveal the wizard's install-Ollama row when nothing answers locally (Linux
*  only), or prefill the endpoint when a local Ollama is already running. */
/**
* Put an async wizard button into a busy state: disabled, label swapped, and a
* small inline spinner — the "doing something" signal lives ON the control the
* user just pressed. Returns a restore function for the finally block.
*/
wireModalsPanel();
/** Recording chrome: mic ⇄ red pulsing stop square + elapsed chip (the
*  standard voice-recorder idiom, so state is unmistakable at a glance). */
/** Wrap accumulated PCM16 frames in a minimal 16 kHz mono WAV container. */
/** Close the current segment and ship it for transcription (if it held speech). */
/** Per-frame handler: RMS gate → segment bookkeeping → cut on pause/length. */
/** Stop capture, flush the tail segment, wait for transcripts, then tidy. */
/** Esc = cancel: discard everything dictated, restore the prior composer text. */
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && isDictationActive()) {
		e.preventDefault();
		cancelDictation();
	}
});
/**
* Tidy the dictated span via the server's cleanup model. The replacement goes
* through execCommand('insertText') over a selection of just the dictated
* text, so the native undo stack (Ctrl/Cmd+Z) restores the raw transcript.
*/
$("#mic-btn")?.addEventListener("click", () => {
	if (isDictationActive()) stopDictation();
	else startDictation();
});
/** Post-auth: reveal the mic when the server has an STT backend configured. */
$("#overflow-btn")?.addEventListener("click", (e) => {
	e.stopPropagation();
	const menu = $("#overflow-menu");
	const open = menu.hidden;
	menu.hidden = !open;
	$("#overflow-btn").setAttribute("aria-expanded", String(open));
	if (open) probeRoutingAvailability();
});
$("#overflow-menu")?.addEventListener("click", (e) => {
	const item = e.target?.closest(".overflow-item");
	if (!item) return;
	closeOverflowMenu();
	const action = item.dataset.action;
	if (action === "agents") openManage("agents");
	else if (action === "models") openManage("models");
	else if (action === "mcp") openManage("mcp");
	else if (action === "skills") openManage("skills");
	else if (action === "routing") openManage("routing");
	else if (action === "journey") toggleJourney();
	else if (action === "topology") toggleTopology();
	else if (action === "wiring") toggleMatrix();
	else if (action === "dashboard") toggleDashboard();
	else if (action === "permissions") togglePermissions();
	else if (action === "admin") toggleAdmin();
	else if (action === "settings") openSettings();
	else if (action === "help") toggleHelp();
});
document.addEventListener("click", (e) => {
	const menu = $("#overflow-menu");
	if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== $("#overflow-btn")) closeOverflowMenu();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeOverflowMenu();
});
$("#settings-close").addEventListener("click", closeSettings);
wireSettingsPanel1();
window.addEventListener("popstate", (e) => {
	if (lightboxOpen.value) {
		closeLightbox(true);
		return;
	}
	const targetDepth = e.state && e.state.viewDepth || 0;
	while (viewStack.length > targetDepth) {
		const top = viewStack.pop();
		try {
			top.teardown();
		} catch (err) {
			console.error("view teardown failed", err);
		}
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape" || viewStack.length === 0) return;
	if (blockingOverlayOpen()) return;
	const t = e.target;
	if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
	e.preventDefault();
	e.stopPropagation();
	if (closeTopDetailAside()) return;
	closeView(viewStack[viewStack.length - 1].name);
}, true);
wireLightbox();
wireSettingsPanel2();
$("#handle-save")?.addEventListener("click", saveHandle);
$("#handle-input")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		saveHandle();
	}
});
wireVisibilityRefresh();
setInterval(() => {
	if (document.visibilityState === "visible") fetchApprovals();
}, 1e4);
wireRoomsPanel();
/**
* Transient corner notification. `kind` is 'info' (default), 'success', or
* 'error'. Errors linger longer and must be dismissed-or-time-out; all toasts
* are click-to-dismiss. Returns the element so callers can remove it early.
*/
wireMembersPanel();
$("#user-creds-oauth-btn")?.addEventListener("click", () => openOauthMintModal("member"));
$("#user-creds-oauth-cancel")?.addEventListener("click", closeUserCredsOauthModal);
$("#user-creds-oauth-close")?.addEventListener("click", closeUserCredsOauthModal);
wireMembersOauth1();
$("#user-creds-oauth-code")?.addEventListener("paste", () => {
	setTimeout(() => {
		const submit = $("#user-creds-oauth-submit");
		if (submit && !submit.hidden && ($("#user-creds-oauth-code")?.value || "").trim()) submit.click();
	}, 0);
});
wireUserCredsOauth();
/**
* Promise-based confirmation modal. Resolves true on confirm, false on
* cancel / backdrop / Escape. `body` may be a string or an HTMLElement (use an
* element when the message contains user-supplied text, so it stays escaped).
* `destructive` styles the confirm button as a delete action and focuses
* Cancel by default.
*/
/** Single-line text prompt in the app's modal chrome — replaces native prompt()
* (unstylable, ESC-inconsistent, blocked in some PWA contexts). Returns the
* trimmed value, or null on cancel/empty.
* `validate(trimmedValue)` (optional): return an error string to keep the modal
* open with that message inline (DESIGN §5 — field validation is inline text),
* or null/undefined to accept. */
wireScrollTracking();
wireTranscriptPanel();
wireComposer();
/**
* Walk a rendered bubble's text nodes and wrap `@<slug>` tokens in a styled
* span. Cosmetic only — even if the token doesn't match a wired agent, the
* styling tells the user "this looks like a mention." Server-side matching
* is what actually decides routing.
*/
$("#members-toggle").addEventListener("click", toggleMembersPanel);
$("#members-close").addEventListener("click", toggleMembersPanel);
$("#members-search")?.addEventListener("input", (e) => {
	membersFilter.value = e.target.value.trim().toLowerCase();
	paintMembersList();
});
wireMembersOauth2();
wireDetailOverlay();
$("#manage-back")?.addEventListener("click", () => closeView("manage"));
wireManageTabs();
/**
* Undo window: swaps an actions row for a sliding countdown + Undo. The action
* commits when the bar empties; Undo restores the row untouched. The timer only
* ever starts from a human CLICK — automation (auto-keep) stays instant — and a
* tab closed mid-countdown commits nothing: the draft simply stays pending,
* which is the safe default.
*/
/** Paint the editor from skillEditorDraft (diff-review or edit mode). */
wireSkillsPanel();
/** The Keep button currently rendered for a draft (null after navigation). */
/** Reflect a draft's in-flight review on its Keep button, if one is rendered. */
wireApprovalsPanel();
wireMobileBack();
wireViewChrome1();
$("#journey-back")?.addEventListener("click", toggleJourney);
$("#journey-refresh")?.addEventListener("click", () => void refreshJourney(true));
wireViewsPanel();
$("#topo-focus-pill")?.addEventListener("click", clearTopoFocus);
$("#matrix-back")?.addEventListener("click", toggleMatrix);
$("#matrix-refresh")?.addEventListener("click", refreshMatrix);
$("#help-back")?.addEventListener("click", toggleHelp);
$("#perms-user-search")?.addEventListener("input", (e) => {
	permsUserFilter.value = e.target.value.trim().toLowerCase();
	renderPermsUserList();
});
/**
* Toggle a permission on or off. `granting=true` calls /grant; false calls
* /revoke. The cell is briefly disabled while the request is in flight, then
* the canonical state is re-fetched from the server.
*/
$("#perms-exit").addEventListener("click", togglePermissions);
$("#admin-exit").addEventListener("click", toggleAdmin);
$("#perms-refresh").addEventListener("click", refreshPermissions);
wirePermsNew();
$("#perms-detail-back").addEventListener("click", permsShowList);
$("#perms-create-back").addEventListener("click", permsShowList);
$("#perms-delete-btn").addEventListener("click", () => {
	if (permsSelectedUserId.value) deleteUser(permsSelectedUserId.value);
});
$("#perms-create-channel").addEventListener("change", () => {
	permsCreateChannelTouched.value = true;
	permsRefreshCreateUI();
});
$("#perms-create-handle").addEventListener("input", permsRefreshCreateUI);
$("#perms-create-raw").addEventListener("input", permsRefreshCreateUI);
$("#perms-create-kind").addEventListener("change", permsRefreshCreateUI);
wirePermsCreate();
$("#dash-detail-close").addEventListener("click", hideDetail);
wireAgentsPanel();
/** Confirm modal with one switch option — the modal twin of .setting-toggle
* (DESIGN.md §2b: binary choices are switches, never raw checkboxes). */
wireAgentControls1();
$("#room-export-btn")?.addEventListener("click", () => {
	const roomId = selectedRoomId.value || state.currentRoom;
	if (!roomId) return;
	const a = document.createElement("a");
	a.href = `/api/rooms/${encodeURIComponent(roomId)}/export`;
	a.download = "";
	document.body.appendChild(a);
	a.click();
	a.remove();
	showToast("Room export started", { kind: "success" });
});
wireFileControls1();
$("#import-room-file")?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	e.target.value = "";
	if (!file) return;
	showToast("Uploading room bundle…", { kind: "info" });
	let up;
	try {
		const fd = new FormData();
		fd.append("bundle", file);
		const res = await authFetch("/api/rooms/import", {
			method: "POST",
			body: fd
		});
		up = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(up.error || res.statusText);
	} catch (err) {
		showToast("Import failed: " + (err?.message || err), { kind: "error" });
		return;
	}
	return continueRoomImport(up);
});
$("#system-export-btn")?.addEventListener("click", async () => {
	const { ok, checked } = await confirmWithToggle({
		title: "Download system backup?",
		toggleLabel: "Lean (skip conversation history — much smaller)",
		note: "Secrets and host identity never travel; a restored install keeps its own credentials.",
		confirmLabel: "Download"
	});
	if (!ok) return;
	showToast("Preparing backup — this can take a while for large installs", { kind: "info" });
	let blob;
	try {
		const res = await authFetch(`/api/system/export${checked ? "?lean=1" : ""}`);
		if (!res.ok) {
			showToast("Backup failed: " + ((await res.json().catch(() => ({}))).error || res.statusText), { kind: "error" });
			return;
		}
		blob = await res.blob();
	} catch (e) {
		showToast("Backup failed: " + (e?.message || "network error"), { kind: "error" });
		return;
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `nanoclaw-backup-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.tgz`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	showToast("Backup downloaded", { kind: "success" });
});
wireFileControls2();
wireAgentControls2();
$("#attach-picker-close").addEventListener("click", closeAttachPicker);
$("#attach-picker .model-picker-backdrop").addEventListener("click", closeAttachPicker);
$("#attach-picker-search").addEventListener("input", (e) => renderAttachPickerList(e.target.value));
$("#attach-picker-add-new").addEventListener("click", () => attachPickerCfg.value?.onAddNew?.());
wireAgentControls3();
wireAgentDetail1();
wireAgentControls4();
wireAgentCreate1();
for (const sel of [
	"#agent-create-draft-prompt",
	"#agent-create-name",
	"#agent-create-instructions"
]) $(sel)?.addEventListener("input", scheduleSkillSuggest);
wireSkillsRegistry();
document.querySelectorAll(".drafter-btn").forEach((btn) => {
	btn.addEventListener("click", () => draftFor(btn));
});
/**
* Learning loop, room-level view: what this room's agents have proposed and what
* they've learned — in the room, rather than buried in the global Skills page.
* Pending proposals first (they need a decision); learned skills below, removable.
* Purely a view over existing endpoints — no new backend.
*/
wireRoomDetail1();
$("#thread-switch")?.addEventListener("click", (e) => {
	e.stopPropagation();
	openThreadSwitcher();
});
$("#thread-pull")?.addEventListener("click", () => syncThread("pull"));
$("#thread-push")?.addEventListener("click", () => syncThread("push"));
$("#thread-delete")?.addEventListener("click", () => {
	if (!state.currentRoom || state.currentThread === "main") return;
	const thread = roomThreads().find((t) => t.thread_id === state.currentThread);
	if (thread) deleteThreadConfirm(thread);
});
$("#room-detail-close").addEventListener("click", closeRoomDetail);
$("#room-delete").addEventListener("click", deleteCurrentRoom);
wireRoomDetail2();
$("#room-rename-save")?.addEventListener("click", saveRoomName);
wireRoomDetail3();
wireAgentDetail2();
wireAgentControls5();
$("#create-room-btn").addEventListener("click", openRoomCreate);
wireRoomDetail4();
wireSortToggle("#room-sort-az", "webchat:roomSortAz", () => roomSortAz.value, (v) => roomSortAz.value = v, () => {
	if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
});
wireSortToggle("#perms-sort-az", "webchat:usersSortAz", () => usersSortAz.value, (v) => usersSortAz.value = v, () => renderPermsUserList());
wireViewChrome2();
$("#room-create-close").addEventListener("click", closeRoomDetail);
wireRoomDetail5();
wireRoomCreate();
/**
* 🎓 popover (DESIGN.md § Composer popups — mirrors .mention-popover, no third
* style). Click the icon → "Distill now" plus the per-agent automation toggles:
*   Auto-distill — admin-tier; it only stages drafts (default ON).
*   Auto-keep    — owner-tier; it writes live agent context, so the server
*                  refuses the toggle for anyone else and the row only renders
*                  when the server says canAutoKeep.
*/
$("#learn-btn")?.addEventListener("click", toggleLearnMenu);
wireLearnPanel();
var typingTimeout = null;
var isTyping = false;
$("#message-input").addEventListener("input", function() {
	updateSlashMenu();
	const prevH = this._prevScrollHeight || this.clientHeight;
	if (this.scrollHeight > this.clientHeight || this.scrollHeight < prevH) {
		this.style.height = "0";
		this.style.height = Math.min(this.scrollHeight, 120) + "px";
	}
	this._prevScrollHeight = this.scrollHeight;
	if (!state.currentRoom || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
	if (!isTyping) {
		isTyping = true;
		state.ws.send(JSON.stringify({
			type: "typing",
			is_typing: true
		}));
	}
	clearTimeout(typingTimeout ?? void 0);
	typingTimeout = setTimeout(() => {
		isTyping = false;
		state.ws.send(JSON.stringify({
			type: "typing",
			is_typing: false
		}));
	}, 2e3);
});
$("#message-form").addEventListener("submit", () => {
	if (isTyping) {
		isTyping = false;
		clearTimeout(typingTimeout ?? void 0);
		state.ws.send(JSON.stringify({
			type: "typing",
			is_typing: false
		}));
	}
});
var messagesEl = $("#messages");
messagesEl.addEventListener("dragover", (e) => {
	e.preventDefault();
	messagesEl.classList.add("drag-over");
});
messagesEl.addEventListener("dragleave", () => {
	messagesEl.classList.remove("drag-over");
});
messagesEl.addEventListener("drop", (e) => {
	e.preventDefault();
	messagesEl.classList.remove("drag-over");
	if (e.dataTransfer.files.length > 0) stageFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
	if (!state.currentRoom) return;
	const files = [...e.clipboardData?.files || []];
	if (files.length > 0) {
		e.preventDefault();
		stageFiles(files);
	}
});
wireComposerPaste();
wireFileControls3();
$("#camera-btn").addEventListener("click", () => {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.capture = "environment";
	input.addEventListener("change", () => {
		if (input.files.length > 0) stageFile(input.files[0]);
	});
	input.click();
});
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) clearBadgeCount();
});
if (!document.hidden) clearBadgeCount();
wireServiceWorker(() => Array.isArray(pendingFiles.value) && pendingFiles.value.length > 0);
$("#router-select")?.addEventListener("change", (e) => {
	routingCurrentRouter.value = e.target.value;
	loadRoutingTab();
});
wireRouterNew();
wireRoutingProfiles();
document.querySelectorAll(".routing-subtab").forEach((b) => {
	b.addEventListener("click", () => switchRoutingSubtab(b.dataset.rsub));
});
wireRoutingPanel();
setTimeout(probeRoutingAvailability, 3e3);
$("#model-detail-close").addEventListener("click", closeModelDetail);
$("#model-create-close").addEventListener("click", closeModelDetail);
wireModelCreate();
$("#model-create-kind").addEventListener("change", syncCreateFormToKind);
$("#model-probe-btn").addEventListener("click", runProbe);
$("#model-probe-url").addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		runProbe();
	}
});
$("#model-probe-select-all").addEventListener("click", () => {
	document.querySelectorAll("#model-probe-list input[type=checkbox]").forEach((cb) => {
		cb.checked = true;
	});
});
$("#model-probe-add-selected").addEventListener("click", addSelectedFromProbe);
bindDiscover("#model-create-discover-btn", () => $("#model-create-kind").value, () => $("#model-create-endpoint").value.trim(), "#model-create-model-id", "#model-create-discover-select");
wireModelsPanel();
/**
* MCP catalog — browse the public registry, prefill the add form.
*
* Discovery only: choosing a row never writes anything. It fills in the form below,
* and the server still has to be probed and added like any hand-entered one.
*
* The remote/package split is the security line. A REMOTE server is a URL the
* container dials out to. A PACKAGE server is npm/pypi code that runs INSIDE the
* agent container, next to its credentials — so it's labelled, and picking one costs
* an explicit confirm naming the exact command. Browsing must never be one click
* away from executing a stranger's code.
*/
/**
* The MCP registry is a switchable source, exactly like a skill collection: the
* same webchat_disabled_sources row, surfaced in Settings the same way. Off means
* off server-side too — the catalog block disappears and no request is made.
*/
/**
* Per-agent env vars. The list shows NAMES only — the server never returns a
* value, so there is nothing to render and nothing to leak into a screenshot.
*/
/**
* One row per credential: the host, a scope pill, and Remove.
*
* The pill (not prose) carries ownership because it is the thing you scan for —
* and `personal` gets the accent colour because it is the EXCEPTION worth
* noticing; shared is the default and stays neutral. Reuses the `.skill-badge`
* vocabulary already used for skill provenance, so the panel doesn't invent a
* second badge language.
*/
/** Labelled input matching the .secret-field pattern used in the static forms. */
/**
* The learning loop's explicit trigger (docs/webchat/design/learning-loop.md §1): reviews
* THIS session and drafts a skill only if it taught something. It just sends
* `/learn` — one path, the same one the slash command takes, so there's no second
* implementation to keep in step.
*
* Only offered for the room you're actually in: `/learn` reviews the session, and
* the session is the one you have open.
*/
/** Hide the catalog entirely when its source is switched off. */
/** Prefill the add form from a catalog row. Package servers gate on an explicit confirm. */
wireMcpCatalog();
$("#mcp-detail-close").addEventListener("click", closeMcpDetail);
$("#mcp-create-close").addEventListener("click", closeMcpDetail);
wireAgentCreate2();
$("#mcp-create-transport").addEventListener("change", syncMcpCreateTransportFields);
wireMcpPanel();
wireAgentDetail3();
$("#model-picker-close").addEventListener("click", closeModelPicker);
$("#model-picker .model-picker-backdrop").addEventListener("click", closeModelPicker);
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("#model-picker").hidden) closeModelPicker();
});
$("#model-picker-search").addEventListener("input", (e) => {
	renderPickerList(e.target.value);
});
$("#model-picker-add-new").addEventListener("click", () => {
	if (!selectedAgentId.value) return;
	setPickerAdd(true, selectedAgentId.value);
	closeModelPicker();
	setTimeout(() => $("#create-model-btn").click(), 180);
});
initApp();
provideThinkingDeps({ interruptAgent });
provideWizardDeps({
	openOauthMintModal,
	fetchAgents,
	closeSettings,
	applyLearningMaster
});
provideInstallerDeps({
	wizardBusy,
	refreshWizardNextGate,
	renderWizardOpencodeInstall,
	renderWizardFeatures,
	refreshWizardCredState,
	renderCredentialsSettings,
	renderTtsSetupSettings,
	renderSttSetupSettings,
	renderRoutingSetup,
	probeRoutingAvailability,
	loadOllamaHostModels,
	fetchModels,
	fetchAgents
});
provideThreadsDeps({
	hideOtherFullViews,
	joinRoom,
	renderRooms,
	roomColor,
	showConfirmModal
});
provideTranscriptDeps({
	agentColor,
	endAgentTurn,
	interruptAgent,
	mentionAgentColor,
	openLightbox,
	skillDraftRow,
	toggleThinkingExpanded
});
provideWsDeps({
	fetchApprovals,
	fetchMentionablePeople,
	handleSkillDraftReview,
	handleTypingEvent,
	joinRoom,
	refreshDraftBadge,
	refreshWiredAgentsForCurrentRoom,
	renderMembers,
	renderRooms,
	triggerLearn
});
provideSkillsDeps({
	closeRoomDetail,
	closeView,
	joinRoom,
	openJourney,
	openManage,
	openView,
	openWireToAgentsPicker,
	showConfirmModal,
	triggerLearn
});
provideMcpDeps({
	closeAgentDetail,
	closeModelDetail,
	closeRoomDetail,
	openAgentDetail,
	showConfirmModal
});
provideAgentsDeps({
	warnIfUnreachable,
	getWiredAgentsForCurrentRoom,
	closeAttachPicker,
	closeModelDetail,
	closeRoomDetail,
	fetchModels,
	inspectAndConfirmImport,
	modelKindLabel,
	openAttachPicker,
	openRoomDetail,
	populateKnownModelOptions,
	showConfirmModal,
	setWiredAgentsForCurrentRoom
});
provideRoomsDeps({
	closeModelDetail,
	fetchMentionablePeople,
	hideLearnNudge,
	hideOtherFullViews,
	renderMembers,
	renderTypingIndicator,
	showConfirmModal,
	updateUserCredsBanner
});
provideModelsDeps({
	closeRouteDetail,
	switchManageTab
});
provideSettingsDeps({
	toggleBearerToken,
	updateUserCredsBanner
});
provideMembersDeps({
	permsShowDetail,
	permsShowList,
	refreshPermissions,
	renderPermsDetail,
	showConfirmModal
});
provideModalsDeps({
	updateHandleCreds,
	acceptMention,
	copyTextToClipboard
});
provideViewsDeps({
	closeAllDetailDrawers,
	loadRoutingTab,
	probeRoutingAvailability,
	refreshRouterMetrics,
	getDetailRouterOpen,
	getAfterDetailClose,
	setAfterDetailClose
});
provideAuthDeps({ permsRefreshCreateUI });
provideLearnDeps({ sendCurrentMessage });
provideFilesDeps({});
provideSelectToggleDeps({
	fetchModels,
	refreshRouterRoster: () => {
		if (!$("#mtab-routing").hidden) renderRouterRoster();
	}
});
providePermsDeps({});
provideRoutingDeps({});
provideComposerDeps({});
//#endregion
