//* TITLE Separator **//
//* VERSION 2.0.0 **//
//* DESCRIPTION Marks where you left off on your dashboard **//
//* DEVELOPER new-xkit **//
//* FRAME false **//
//* SLOW false **//
//* BETA false **//

// # Motivation
// Some of us like to catch up with all the posts that we’ve missed since we last checked our dashboard.
// Placing a visual separator to show where we left off helps with that.
//
// # Approach
// For each context (dashboard, specific blog, or specific tag) we track the newest post we’ve previously witnessed.
// This is our “goal post” (above which we’ll place the separator).
// When we return to the context, we track the set of posts that we’ve witnessed that’s newer than the goal post.
// Once we reach the goal post, we place the separator.
// We then reset the goal post (to the newest post in the contiguous interval of witnessed posts that’s touching the goal post).
//
// # Implementation-specific Caveats
//   - We don’t actually track the set of discrete witnessed posts; we track a set of disjoint intervals representing contiguously witnessed posts.
//     This approach should tolerate deleted posts.
//     However, a witnessed post that’s subsequently been edited will still be treated as witnessed.
//   - When endless scrolling is off, merging of seemingly disjoint intervals from adjacent pages relies on URL hints.
//     If these hints are missing, we’ll fail to merge these intervals.
//     Consequently, once the goal post resets, we’ll find it pointing to an older than expected post.
//     The workaround is to manually trigger a goal post reset (with the separator controls).
//     Hints might be missing if we manually browse to a page’s URL.
//     They might also _go_ missing should Tumblr change their URL patterns.
//   - When the same context is open in multiple tabs, behaviour may seem unpredictable.
//
// # Checklist
//   - [ ] Refactor once I eventually get around to adding separator support for channel views.
//   - [ ] Check for whether this extension conflicts with any of the other extensions.
//   - [ ] Add a per-context reset control (so users needn’t wipe the entire extension’s settings).
//   - [ ] Add a per-context enable/disable control (so users can opt in/out of placing separators on the dashboard or specific tags).
//   - [ ] Add visual indicators (so users know which posts have been witnessed, and roughly how far they are from the separator).
//   - [ ] Deal with post IDs occasionally breaking the (assumed) strictly decreasing invariant.
//         I’ve seen this a couple of times in tagged views; the “out-of-order” posts seem to share the same timestamp.
//         My money is on those posts being queued (and thus having pre-assigned IDs), coupled with the views using timestamp ordering (and not ID ordering as first thought).
//   - [ ] Explore alternative approaches to tracking witnessed posts.
//         Per-post tracking would reduce confusion when switching contexts.

"use strict";

XKit.extensions.separator = (function() {
	const LATEST_STORAGE_VERSION = 2;
	const RECONCILE_ABORT = 0;
	const RECONCILE_DEFER = -1;

	let running = false;
	let drawBoldLine = false;
	let showControls = false;

	// Generic helper functions

	function isSafePositiveInteger(value) {
		return (Number.isSafeInteger(value) && (value > 0));
	}

	function areSortedDisjointSafeIntegerIntervals(intervals) {
		if (!Array.isArray(intervals)) { return false; }
		let prevUpperEndpoint = Number.NEGATIVE_INFINITY;
		for (const interval of intervals) {
			if (!(Array.isArray(interval) && (interval.length === 2))) { return false; }
			const [lowerEndpoint, upperEndpoint] = interval;
			if (!(Number.isSafeInteger(lowerEndpoint) && Number.isSafeInteger(upperEndpoint))) { return false; }
			if (!((prevUpperEndpoint < lowerEndpoint) && (lowerEndpoint < upperEndpoint))) { return false; }
			prevUpperEndpoint = upperEndpoint;
		}
		return true;
	}

	function addToSortedDisjointSafeIntegerIntervals(intervals, interval) {
		// Assumed preconditions:
		//   - `intervals` is a sorted disjoint set of safe integer intervals; and
		//   - `interval` is a safe integer interval.
		let spliceStart = 0, spliceDeleteCount = 0;
		let preservedEndpoints = 0;
		let [newLowerEndpoint, newUpperEndpoint] = interval;
		for (const [oldLowerEndpoint, oldUpperEndpoint] of intervals) {
			if (oldUpperEndpoint < newLowerEndpoint) { ++spliceStart; continue; }
			if (newUpperEndpoint < oldLowerEndpoint) { break; }
			if ((oldLowerEndpoint <= newLowerEndpoint) && (newLowerEndpoint <= oldUpperEndpoint)) {
				newLowerEndpoint = oldLowerEndpoint;
				++preservedEndpoints;
			}
			if ((oldLowerEndpoint <= newUpperEndpoint) && (newUpperEndpoint <= oldUpperEndpoint)) {
				newUpperEndpoint = oldUpperEndpoint;
				++preservedEndpoints;
			}
			++spliceDeleteCount;
		}
		const updated = (!((spliceDeleteCount === 1) && (preservedEndpoints === 2)));
		if (updated) {
			intervals.splice(spliceStart, spliceDeleteCount, [newLowerEndpoint, newUpperEndpoint]);
		}
		return updated;
	}

	function indexOfIntervalContainingValue(intervals, value) {
		// Assumed preconditions:
		//   - `intervals` is a sorted disjoint set of safe integer intervals; and
		//   - `value` is a safe integer.
		let index = 0;
		for (const [lowerEndpoint, upperEndpoint] of intervals) {
			if (upperEndpoint < value) { ++index; continue; }
			if (value < lowerEndpoint) { break; }
			return index;
		}
		return -1;
	}

	// Internal functions

	function initContext() {
		function validCursors({goalPostId, witnessedPostIds}) {
			if (!Array.isArray(witnessedPostIds)) { return false; }
			if (isSafePositiveInteger(goalPostId)) {
				return areSortedDisjointSafeIntegerIntervals([[0, goalPostId], ...witnessedPostIds]);
			}
			return ((goalPostId === null) && (witnessedPostIds.length === 0));
		}
		function validTaggedCursors({goalPostId, witnessedPostIds, adjacencyHints}) {
			if (!validCursors({goalPostId, witnessedPostIds})) { return false; }
			if (!(!!adjacencyHints && (adjacencyHints.constructor === Map))) { return false; }
			if (witnessedPostIds.length === 0) {
				return (adjacencyHints.size === 0);
			}
			for (const [timestamp, postId] of adjacencyHints) {
				if (!(isSafePositiveInteger(timestamp) && isSafePositiveInteger(postId))) { return false; }
				// We should only be storing hints mapping to posts that we’ve witnessed.
				if (indexOfIntervalContainingValue(witnessedPostIds, postId) === -1) { return false; }
			}
			return true;
		}

		const where = XKit.interface.where();

		if (where.dashboard) {
			let isFirstPage = false;
			let augmentWithAdjacencyHints = (cursors, witnessedPostIds) => { return witnessedPostIds; };

			// This approach isn’t foolproof.
			// For instance, a future post ID would mean we’re actually on the first page.
			const [,, rawPageNumber, rawSignedPostId] = document.location.pathname.split("/");
			const pageNumber = Number(rawPageNumber);
			if (!(isSafePositiveInteger(pageNumber) && (pageNumber > 1))) {
				isFirstPage = true;
			} else {
				const signedPostId = Number(rawSignedPostId);
				if (Number.isSafeInteger(signedPostId) && (signedPostId !== 0)) {
					const postId = Math.abs(signedPostId);
					if (signedPostId > 0) {
						augmentWithAdjacencyHints = (cursors, [oldestWitnessedPostId, newestWitnessedPostId]) => {
							if (indexOfIntervalContainingValue(cursors.witnessedPostIds, postId) !== -1) {
								return [oldestWitnessedPostId, postId];
							}
							return [oldestWitnessedPostId, newestWitnessedPostId];
						};
					} else {
						augmentWithAdjacencyHints = (cursors, [oldestWitnessedPostId, newestWitnessedPostId]) => {
							if (indexOfIntervalContainingValue(cursors.witnessedPostIds, postId) !== -1) {
								return [postId, newestWitnessedPostId];
							}
							return [oldestWitnessedPostId, newestWitnessedPostId];
						};
					}
				}
			}

			const loadCursors = () => {
				const [goalPostId, witnessedPostIds] = JSON.parse(XKit.storage.get("separator", "cursors:dashboard", "[null,[]]"));
				if (!validCursors({goalPostId, witnessedPostIds})) {
					throw new Error("Loaded invalid cursors");
				}
				return {goalPostId, witnessedPostIds};
			};
			const saveCursors = ({goalPostId, witnessedPostIds}) => {
				if (!validCursors({goalPostId, witnessedPostIds})) {
					throw new Error("Attempted to save invalid cursors");
				}
				XKit.storage.set("separator", "cursors:dashboard", JSON.stringify([goalPostId, witnessedPostIds]));
			};

			const addControls = (controls, cursors) => {
				// The goal post ID should never be `null` after we’ve performed the initial reconciliation, but whatever.
				if (cursors.goalPostId !== null) {
					const jump = document.createElement("li");
					jump.className = "item";

					const jumpAnchor = document.createElement("a");
					// We’ll assume nobody’s ever gonna be 1000 posts behind _and_ willing to work their way back through more than 100 pages in one go.
					// Note that if we reached the goal post during initial reconciliation, then the URL will point to the new goal post, but the handler will take us to the old goal post.
					jumpAnchor.href = `/dashboard/100/${cursors.goalPostId + 1}`;
					jumpAnchor.textContent = "Go to last viewed post";
					jumpAnchor.addEventListener("click", (event) => {
						const line = document.getElementById("xkit-separator-line");
						if (line !== null) {
							event.preventDefault();
							// The separator’s offset parent should be `body`.
							// We’ve hard-coded an adjustment of 74 px to account for the header (54 px) and margin between posts (20 px).
							$("html, body").animate({
								"scrollTop": line.offsetTop - 74,
							}, 333);
						}
					});
					jump.appendChild(jumpAnchor);

					// The jump control isn’t terribly useful when endless scrolling is on, since there’s no way to go load newer posts.
					// Perhaps we should warn users of this limitation.
					controls.appendChild(jump);
				}
			};

			return {
				"shouldContinue": true,
				"mayDefer": where.endless,
				isFirstPage,
				augmentWithAdjacencyHints,
				"updateAdjacencyHints": (cursors, postIds) => {},
				loadCursors,
				saveCursors,
				addControls,
			};
		}

		if (where.tagged) {
			// For tagged views, we need to massage the tag into a canonical form.
			//
			// At the time of writing, the URL path is _not_ reliably canonicalised.
			// For instance, </tagged/foo+bar>, </tagged/foo%20bar>, and </tagged/FoO-BaR> all redirect to </tagged/foo-bar>.
			// However, the path to the next page of results (when endless scrolling is off) is </tagged/foo+bar>.
			// Furthermore, leading and trailing “spaces” are retained, to varying extents.
			// For instance, </tagged/+foo-bar-> does not redirect. However, </tagged/+foo-bar%20-> redirects to </tagged/foo-bar-->.
			//
			// Rather than writing (and messing up) our own canonicaliser, we’re gonna read from an element that _appears_ to be reliably consistent.
			const tagElem = document.querySelector("#right_column > .tag_controls .tag");
			if (tagElem === null) {
				throw new Error("Failed to locate tag element");
			}
			const tag = tagElem.textContent.trim();
			const storageKey = `cursors:tagged:${btoa(tag)}`;

			let isFirstPage = true;
			let augmentWithAdjacencyHints = (cursors, witnessedPostIds) => { return witnessedPostIds; };

			// This approach isn’t foolproof.
			// For instance, a future timestamp would mean we’re actually on the first page.
			const pageTimestamp = Number(new URLSearchParams(document.location.search).get("before"));
			if (isSafePositiveInteger(pageTimestamp)) {
				isFirstPage = false;
				augmentWithAdjacencyHints = (cursors, [oldestWitnessedPostId, newestWitnessedPostId]) => {
					const postId = cursors.adjacencyHints.get(pageTimestamp);
					if ((postId !== undefined) && (indexOfIntervalContainingValue(cursors.witnessedPostIds, postId) !== -1)) {
						return [oldestWitnessedPostId, postId];
					}
					return [oldestWitnessedPostId, newestWitnessedPostId];
				};
			}

			const updateAdjacencyHints = ({witnessedPostIds, adjacencyHints}, postIds) => {
				if (witnessedPostIds.length === 0) {
					adjacencyHints.clear();
				} else {
					const nextPage = document.getElementById("next_page_link");
					if (nextPage !== null) {
						const nextPageTimestamp = Number(new URLSearchParams(nextPage.search).get("before"));
						if (isSafePositiveInteger(nextPageTimestamp)) {
							const oldestWitnessedPostId = postIds[postIds.length - 1];
							adjacencyHints.set(nextPageTimestamp, oldestWitnessedPostId);
						}
					}
					// We could also prune any timestamp-to-post-ID entries where the post ID doesn’t lie on the endpoint of an interval.
				}
			};

			const loadCursors = () => {
				const [goalPostId, witnessedPostIds, rawAdjacencyHints] = JSON.parse(XKit.storage.get("separator", storageKey, "[null,[],[]]"));
				const adjacencyHints = new Map(rawAdjacencyHints);
				if (!validTaggedCursors({goalPostId, witnessedPostIds, adjacencyHints})) {
					throw new Error("Loaded invalid cursors");
				}
				return {goalPostId, witnessedPostIds, adjacencyHints};
			};
			const saveCursors = ({goalPostId, witnessedPostIds, adjacencyHints}) => {
				if (!validTaggedCursors({goalPostId, witnessedPostIds, adjacencyHints})) {
					throw new Error("Attempted to save invalid cursors");
				}
				const rawAdjacencyHints = Array.from(adjacencyHints);
				XKit.storage.set("separator", storageKey, JSON.stringify([goalPostId, witnessedPostIds, rawAdjacencyHints]));
			};

			// We can’t really jump to the separator without a reliable mechanism for determining the goal post’s timestamp.
			// That’s a skirmish for another day.
			const addControls = (controls, cursors) => {};

			return {
				"shouldContinue": true,
				"mayDefer": where.endless,
				isFirstPage,
				augmentWithAdjacencyHints,
				updateAdjacencyHints,
				loadCursors,
				saveCursors,
				addControls,
			};
		}

		return {"shouldContinue": false};
	}

	function upgradeStorage() {
		const storageVersion = XKit.storage.get("separator", "version", 1);
		if (!(isSafePositiveInteger(storageVersion) && (storageVersion <= LATEST_STORAGE_VERSION))) {
			throw new Error("Unexpected storage version");
		}

		if (storageVersion < LATEST_STORAGE_VERSION) {
			if (storageVersion <= 1) {
				// Storage should be in v1 format; upgrading to v2 format.
				const lastPost = XKit.storage.get("separator", "last_post");
				XKit.storage.remove("separator", "last_post");
				if (isSafePositiveInteger(lastPost)) {
					XKit.storage.set("separator", "cursors:dashboard", JSON.stringify([lastPost, []]));
				}
			}

			XKit.storage.set("separator", "version", LATEST_STORAGE_VERSION);
		}
	}

	function enumerateDashboardPostIds() {
		const postElems = document.querySelectorAll("#posts > .post_container > .post:not(.new_post_buttons):not(.sponsored_post)");
		const postIds = [];
		let prevPostId = Number.POSITIVE_INFINITY;
		for (const postElem of postElems) {
			if (postElem.querySelector("a.recommendation-reason-link[data-trending-id=\"staff-picks\"]") !== null) { continue; }
			const postId = Number(postElem.dataset.id);
			if (!isSafePositiveInteger(postId)) {
				throw new Error("Failed to extract valid ID from post element");
			}
			if (postId >= prevPostId) {
				throw new Error("Encountered post that violates the expectation that posts must be ordered by strictly decreasing IDs");
			}
			postIds.push(postId);
			prevPostId = postId;
		}
		return postIds;
	}

	function reconcile(cursors, postIds, initial, isFirstPage, augmentWithAdjacencyHints, updateAdjacencyHints, saveCursors) {
		// Updates (and saves) `cursors` based on `postIds`.
		//
		// Returns:
		//   - the best goal post ID from `postIds` above which to place the separator;
		//   - `RECONCILE_DEFER` if `postIds` are newer than the goal post ID; or
		//   - `RECONCILE_ABORT` for all other scenarios.
		//
		// Assumed preconditions:
		//   - `cursors` is valid;
		//   - `postIds` is a reverse sorted array of safe positive integers representing posts loaded into the DOM; and
		//   - `augmentWithAdjacencyHints`, `updateAdjacencyHints`, and `saveCursors` are valid functions.
		//
		// Other assumptions:
		//   - we need only update adjacency hints if `cursors` actually changes; and
		//   - when loading older posts via endless scrolling, each `post_listener` update will always have some overlap with the previous update.

		if (postIds.length === 0) {
			// We could legitimately be dealing with an empty context, or we could be glitched.
			// Best do nothing.
			return RECONCILE_ABORT;
		}

		if (initial && (cursors.goalPostId === null)) {
			// Looks like this is the first time we’ve visited this context.
			// We’ll set the goal post to the newest witnessed post.
			// `cursors.witnessedPostIds` should be empty, since we started off with a valid `cursors`.
			// Consequently, we shouldn’t need to update adjacency hints.
			const newestWitnessedPostId = postIds[0];
			cursors.goalPostId = newestWitnessedPostId;
			saveCursors(cursors);
			return newestWitnessedPostId;
		}

		// We should have a valid goal post from here on out.
		if (!isSafePositiveInteger(cursors.goalPostId)) {
			throw new Error("Invariants broken");
		}

		// This might not form a valid interval if `postIds` comprises a single post ID.
		// We’ll account for this (when such cases are valid) shortly.
		let oldestWitnessedPostId = postIds[postIds.length - 1], newestWitnessedPostId = postIds[0];

		if (initial) {
			if (newestWitnessedPostId < cursors.goalPostId) {
				if (isFirstPage) {
					// Looks like the original goal post was deleted.
					// We’ll reset the goal post to whatever is newest on this first page.
					// Since we’re clearing `cursors.witnessedPostIds`, we’ll also need to clear out the now-stale adjacency hints.
					cursors.goalPostId = newestWitnessedPostId;
					cursors.witnessedPostIds = [];
					updateAdjacencyHints(cursors, postIds);
					saveCursors(cursors);
					return newestWitnessedPostId;
				}
				// Looks like we’re trawling through past posts.
				// No need to continue.
				return RECONCILE_ABORT;
			}

			[oldestWitnessedPostId, newestWitnessedPostId] = augmentWithAdjacencyHints(cursors, [oldestWitnessedPostId, newestWitnessedPostId]);
		}

		// We should have a valid interval from here on out.
		// (We’re assuming that there’ll always be at least two posts loaded into the DOM when endless scrolling is on.)
		// (We’re also assuming that there’ll always be overlaps in loaded DOM posts for subsequent updates.)
		if (newestWitnessedPostId <= oldestWitnessedPostId) {
			throw new Error("Invariants broken");
		}

		const cursorsUpdated = addToSortedDisjointSafeIntegerIntervals(cursors.witnessedPostIds, [oldestWitnessedPostId, newestWitnessedPostId]);
		const index = indexOfIntervalContainingValue(cursors.witnessedPostIds, cursors.goalPostId);

		if (index === -1) {
			// “Are we there _yet_?” / “Yes.” / “Really?” / “NO!”
			if (cursorsUpdated) {
				updateAdjacencyHints(cursors, postIds);
				saveCursors(cursors);
			}
			return RECONCILE_DEFER;
		}

		// If we’ve reached the goal post, it should be in the first interval.
		if (!(cursorsUpdated && (index === 0))) {
			throw new Error("Invariants broken");
		}

		// Find the best goal post ID from `postIds`.
		let bestGoalPostId = postIds[postIds.length - 1];
		for (let i = postIds.length - 2; i > -1; --i) {
			const postId = postIds[i];
			if (cursors.goalPostId < postId) { break; }
			bestGoalPostId = postId;
		}

		// Update cursors.
		const newGoalPostId = cursors.witnessedPostIds[0][1];
		cursors.goalPostId = newGoalPostId;
		cursors.witnessedPostIds.shift();
		updateAdjacencyHints(cursors, postIds);
		saveCursors(cursors);

		return bestGoalPostId;
	}

	function insertSeparatorBeforePost(postId) {
		// Assumed preconditions:
		//   - `postId` is a safe positive integer.

		if (document.getElementById("xkit-separator-line") !== null) {
			throw new Error("Separator already exists");
		}

		const post = document.querySelector(`#posts > .post_container[data-pageable="post_${postId}"]`);
		if (post === null) {
			throw new Error("Failed to locate post element");
		}

		const line = document.createElement("li");
		line.id = "xkit-separator-line";
		if (drawBoldLine) {
			line.className = "xkit-separator-bold-line";
		}
		post.parentNode.insertBefore(line, post);
	}

	// Exposed functions

	function run() {
		running = true;

		const {
			shouldContinue, mayDefer, isFirstPage,
			augmentWithAdjacencyHints, updateAdjacencyHints,
			loadCursors, saveCursors,
			addControls,
		} = initContext();
		if (!shouldContinue) { return; }

		XKit.tools.init_css("separator");

		upgradeStorage();
		const cursors = loadCursors();
		const initialPostIds = enumerateDashboardPostIds();
		const initialGoalPostId = reconcile(cursors, initialPostIds, true, isFirstPage, augmentWithAdjacencyHints, updateAdjacencyHints, saveCursors);
		if (isSafePositiveInteger(initialGoalPostId)) {
			insertSeparatorBeforePost(initialGoalPostId);
		} else if (mayDefer && (initialGoalPostId === RECONCILE_DEFER)) {
			XKit.post_listener.add("separator", () => {
				const updatedPostIds = enumerateDashboardPostIds();
				// TODO: Handle exceptions (by removing the post listener), or make `reconcile` less dramatic.
				const updatedGoalPostId = reconcile(cursors, updatedPostIds, false, isFirstPage, augmentWithAdjacencyHints, updateAdjacencyHints, saveCursors);
				if (isSafePositiveInteger(updatedGoalPostId)) {
					insertSeparatorBeforePost(updatedGoalPostId);
					// With endless scrolling, witnessing new posts still requires a reload.
					// Since the cursors won’t change until we witness new posts, we no longer need this listener.
					XKit.post_listener.remove("separator");
				}
			});
		}

		if (showControls) {
			// Hopefully the radar is a reliably ever-present element.
			const radar = document.querySelector("#right_column > .controls_section_radar");
			if (radar !== null) {
				const controls = document.createElement("ul");
				controls.id = "xkit-separator-controls";
				controls.className = "controls_section";

				const controlsHeader = document.createElement("li");
				controlsHeader.className = "section_header";
				controlsHeader.textContent = "Separator";
				controls.appendChild(controlsHeader);

				addControls(controls, cursors);

				radar.parentElement.insertBefore(controls, radar);
			}
		}
	}

	function destroy() {
		XKit.post_listener.remove("separator");

		// We shouldn’t need to explicitly remove event listeners, since browsers are smart cookies.
		const elems = document.querySelectorAll("#xkit-separator-line, #xkit-separator-controls");
		for (const elem of elems) { elem.remove(); }

		XKit.tools.remove_css("separator");

		running = false;
	}

	// Exposed API object
	const preferences = Object.freeze({
		"bold_line": Object.freeze({
			"text": "Draw the separator with a thicker line",
			"default": false,
			get value() { return drawBoldLine; },
			set value(newValue) { drawBoldLine = newValue; },
		}),
		"jump_to": Object.freeze({
			// We’re piggybacking off a legacy preference, hence the semantic mismatch between the key’s name and the preference’s current effect.
			"text": "Show controls in the right column",
			"default": false,
			get value() { return showControls; },
			set value(newValue) { showControls = newValue; },
		}),
	});
	const api = Object.freeze({
		get running() { return running; },
		preferences,
		run,
		destroy,
	});
	return api;
}());
