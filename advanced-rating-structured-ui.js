// Structured per-entity rating controls. Loaded after advanced-rating-ui.js.
(function () {
    'use strict';

    const PLUGIN_ID = 'advancedRating';
    const FIELD_PREFIX = 'advancedRating';
    const SCORE_PATTERN = /^(.+?)\s*:\s*([0-5])$/;
    const TAG_SUFFIX = ' ★';

    const DOMAINS = {
        scene: {
            prefix: 'scene_',
            urlPattern: /\/scenes\/(\d+)/,
            triggerId: 'adv-rating-trigger',
            defaults: {
                groups: [{ id: 'overall', name: 'Overall', weight: 1 }],
                criteria: [
                    { id: 'production_quality', name: 'Production Quality', group: 'overall', weight: 1, enabled: true },
                    { id: 'chemistry', name: 'Chemistry', group: 'overall', weight: 1, enabled: true },
                    { id: 'performance', name: 'Performance', group: 'overall', weight: 1, enabled: true },
                    { id: 'aesthetics', name: 'Aesthetics', group: 'overall', weight: 1, enabled: true },
                    { id: 'creativity', name: 'Creativity', group: 'overall', weight: 1, enabled: true },
                ],
            },
        },
        performer: {
            prefix: 'performer_',
            urlPattern: /\/performers\/(\d+)/,
            triggerId: 'perf-rating-trigger',
            defaults: {
                groups: [
                    { id: 'physical', name: 'Physical', weight: 1 },
                    { id: 'performance', name: 'Performance', weight: 1 },
                ],
                criteria: [
                    { id: 'face', name: 'Face', group: 'physical', weight: 1, enabled: true },
                    { id: 'breasts', name: 'Breasts', group: 'physical', weight: 1, enabled: true },
                    { id: 'ass', name: 'Ass', group: 'physical', weight: 1, enabled: true },
                    { id: 'body', name: 'Body Overall', group: 'physical', weight: 1, enabled: true },
                    { id: 'genitals', name: 'Genitals', group: 'physical', weight: 1, enabled: true },
                    { id: 'technique', name: 'Technique', group: 'performance', weight: 1, enabled: true },
                    { id: 'energy', name: 'Energy & Presence', group: 'performance', weight: 1, enabled: true },
                    { id: 'sluttiness', name: 'Sluttiness', group: 'performance', weight: 1, enabled: true },
                ],
            },
        },
    };

    let configCache = null;
    let configCacheAt = 0;
    let decorateTimer = null;

    async function gql(query, variables) {
        const response = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: variables || {} }),
        });
        const payload = await response.json();
        if (payload.errors && payload.errors.length) throw new Error(payload.errors.map(e => e.message).join('; '));
        return payload.data;
    }

    function coerceBool(value, fallback) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
        if (typeof value === 'number') return value !== 0;
        return fallback;
    }

    function coerceFloat(value, fallback) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    async function getConfig() {
        if (configCache && Date.now() - configCacheAt < 3000) return configCache;
        const data = await gql('query { configuration { plugins } }');
        configCache = (data.configuration && data.configuration.plugins && data.configuration.plugins[PLUGIN_ID]) || {};
        configCacheAt = Date.now();
        return configCache;
    }

    function groupsFromConfig(config, domain) {
        const raw = config[domain.prefix + 'group_ids'];
        if (!raw || typeof raw !== 'string') return domain.defaults.groups.map(g => ({ ...g }));
        const ids = raw.split(',').map(v => v.trim()).filter(Boolean);
        return ids.map(id => {
            const def = domain.defaults.groups.find(g => g.id === id);
            return {
                id,
                name: config[domain.prefix + 'group_name_' + id] || (def ? def.name : id),
                weight: coerceFloat(config[domain.prefix + 'group_weight_' + id], def ? def.weight : 1),
            };
        });
    }

    function criteriaFromConfig(config, domain, groups) {
        const raw = config[domain.prefix + 'criteria_ids'];
        if (!raw || typeof raw !== 'string') {
            return domain.defaults.criteria.filter(c => {
                const legacy = c.id === 'body' ? 'body_overall' : (c.id === 'energy' ? 'energy_presence' : c.id);
                return !coerceBool(config[domain.prefix + 'disable_' + legacy], false);
            }).map(c => ({ ...c }));
        }
        const validGroups = new Set(groups.map(g => g.id));
        const fallbackGroup = groups.length ? groups[0].id : 'overall';
        return raw.split(',').map(v => v.trim()).filter(Boolean).map(id => {
            const def = domain.defaults.criteria.find(c => c.id === id);
            let group = config[domain.prefix + 'group_' + id] || (def ? def.group : fallbackGroup);
            if (!validGroups.has(group)) group = fallbackGroup;
            return {
                id,
                name: config[domain.prefix + 'name_' + id] || (def ? def.name : id),
                group,
                weight: coerceFloat(config[domain.prefix + 'weight_' + id], def ? def.weight : 1),
                enabled: coerceBool(config[domain.prefix + 'enabled_' + id], def ? def.enabled : true),
            };
        }).filter(c => c.enabled);
    }

    async function getModel(domain) {
        const config = await getConfig();
        const groups = groupsFromConfig(config, domain);
        return { groups, criteria: criteriaFromConfig(config, domain, groups) };
    }

    function ratingKey(domainName, criterionId) { return `${FIELD_PREFIX}.${domainName}.rating.${criterionId}`; }
    function naKey(domainName, criterionId) { return `${FIELD_PREFIX}.${domainName}.na.${criterionId}`; }

    function numericScore(value) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5) return value;
        if (typeof value === 'string' && /^[0-5]$/.test(value.trim())) return Number(value.trim());
        return null;
    }

    async function fetchEntity(domainName, entityId) {
        const query = domainName === 'scene'
            ? `query($id: ID!) { findScene(id: $id) { id custom_fields tags { id name } } }`
            : `query($id: ID!) { findPerformer(id: $id) { id custom_fields tags { id name } } }`;
        const data = await gql(query, { id: String(entityId) });
        return domainName === 'scene' ? data.findScene : data.findPerformer;
    }

    async function updateCustomFields(domainName, entityId, input) {
        const mutation = domainName === 'scene'
            ? `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`
            : `mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`;
        await gql(mutation, { input: { id: String(entityId), custom_fields: input } });
    }

    function legacyScore(entity, criterion, groups) {
        const group = groups.find(g => g.id === criterion.group);
        const groupName = group ? group.name : criterion.group;
        const allowed = new Set([`${groupName} · ${criterion.name}${TAG_SUFFIX}`, `${criterion.name}${TAG_SUFFIX}`]);
        for (const tag of (entity.tags || [])) {
            const match = String(tag.name || '').match(SCORE_PATTERN);
            if (match && allowed.has(match[1].trim())) return Number(match[2]);
        }
        return null;
    }

    function readState(domainName, entity, criterion, groups) {
        const fields = entity.custom_fields || {};
        if (fields[naKey(domainName, criterion.id)] === true) return { score: null, na: true, source: 'structured' };
        const structured = numericScore(fields[ratingKey(domainName, criterion.id)]);
        if (structured !== null) return { score: structured, na: false, source: 'structured' };
        const legacy = legacyScore(entity, criterion, groups);
        if (legacy !== null) return { score: legacy, na: false, source: 'legacy' };
        return { score: null, na: false, source: 'unrated' };
    }

    function contextForHost(host) {
        if (host.id === 'adv-rating-performer-side-panel') {
            return host.dataset.performerId ? { domainName: 'performer', entityId: host.dataset.performerId } : null;
        }
        if (host.id === 'perf-rating-modal') {
            const m = location.pathname.match(DOMAINS.performer.urlPattern);
            return m ? { domainName: 'performer', entityId: m[1] } : null;
        }
        const m = location.pathname.match(DOMAINS.scene.urlPattern);
        return m ? { domainName: 'scene', entityId: m[1] } : null;
    }

    function criterionForRow(row, model) {
        const label = row.querySelector('.rating-label > span:first-child');
        const name = label ? label.textContent.trim() : '';
        const matches = model.criteria.filter(c => c.name === name);
        return matches.length === 1 ? matches[0] : null;
    }

    function addPill(label, text, className, title) {
        const pill = document.createElement('span');
        pill.className = `ar-state-pill ${className}`;
        pill.textContent = text;
        if (title) pill.title = title;
        label.appendChild(pill);
    }

    function decorateRow(row, state, criterion, context) {
        row.dataset.arDomain = context.domainName;
        row.dataset.arEntityId = context.entityId;
        row.dataset.arCriterionId = criterion.id;
        row.classList.toggle('ar-not-applicable', state.na);
        row.classList.toggle('rating-unrated', !state.na && state.score === null);

        const stars = row.querySelector('.rating-stars-modal');
        if (!stars) return;
        const starNodes = Array.from(stars.querySelectorAll('.rating-star'));
        starNodes.forEach((star, index) => {
            star.textContent = (!state.na && state.score !== null && index + 1 <= state.score) ? '★' : '☆';
            star.classList.toggle('ar-disabled', state.na);
        });

        let zero = stars.querySelector('.ar-zero-rating');
        if (!zero) {
            zero = document.createElement('button');
            zero.type = 'button';
            zero.className = 'ar-zero-rating';
            zero.textContent = '0';
            zero.title = 'Set explicit zero-star rating';
            stars.insertBefore(zero, stars.firstChild);
        }
        zero.classList.toggle('active', !state.na && state.score === 0);
        zero.disabled = state.na;

        const clear = stars.querySelector('.rating-clear');
        if (clear) clear.title = 'Clear rating (Unrated)';

        let na = stars.querySelector('.ar-na-rating');
        if (!na) {
            na = document.createElement('button');
            na.type = 'button';
            na.className = 'ar-na-rating';
            na.textContent = 'N/A';
            stars.appendChild(na);
        }
        na.classList.toggle('active', state.na);
        na.title = state.na ? 'Restore criterion to Unrated' : 'Mark Not Applicable for this item';

        const label = row.querySelector('.rating-label');
        if (label) {
            label.querySelectorAll('.adv-rating-unrated-pill, .ar-state-pill').forEach(n => n.remove());
            if (state.na) addPill(label, 'N/A', 'ar-state-pill-na');
            else if (state.score === null) addPill(label, 'unrated', 'ar-state-pill-unrated');
            else if (state.source === 'legacy') addPill(label, 'legacy', 'ar-state-pill-legacy', 'Legacy tag value; editing converts this criterion to structured storage');
        }
    }

    async function decorateHost(host) {
        if (!host || !host.isConnected || host.dataset.arDecorating === '1') return;
        const context = contextForHost(host);
        if (!context) return;
        host.dataset.arDecorating = '1';
        try {
            const domain = DOMAINS[context.domainName];
            const [model, entity] = await Promise.all([getModel(domain), fetchEntity(context.domainName, context.entityId)]);
            if (!entity || !host.isConnected) return;
            const states = [];
            host.querySelectorAll('.rating-row').forEach(row => {
                const criterion = criterionForRow(row, model);
                if (!criterion) return;
                const state = readState(context.domainName, entity, criterion, model.groups);
                decorateRow(row, state, criterion, context);
                states.push(state);
            });
            const summary = host.querySelector('.adv-rating-summary');
            if (summary) {
                const na = states.filter(s => s.na).length;
                const rated = states.filter(s => !s.na && s.score !== null).length;
                const unrated = states.length - na - rated;
                summary.textContent = `${states.length - na} applicable · ${rated} rated`;
                if (unrated) { summary.append(' · '); addPill(summary, `${unrated} unrated`, 'ar-state-pill-unrated'); }
                if (na) { summary.append(' · '); addPill(summary, `${na} N/A`, 'ar-state-pill-na'); }
            }
        } catch (e) {
            console.warn('[advancedRating] structured UI decoration failed', e);
        } finally {
            host.dataset.arDecorating = '0';
        }
    }

    function scheduleDecorate() {
        if (decorateTimer) clearTimeout(decorateTimer);
        decorateTimer = setTimeout(() => {
            decorateTimer = null;
            document.querySelectorAll('#adv-rating-inline-panel, #adv-rating-modal, #perf-rating-modal, #adv-rating-performer-side-panel')
                .forEach(decorateHost);
        }, 80);
    }

    async function handleAction(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const star = target.closest('.rating-star');
        const clear = target.closest('.rating-clear');
        const zero = target.closest('.ar-zero-rating');
        const na = target.closest('.ar-na-rating');
        if (!star && !clear && !zero && !na) return;
        const row = target.closest('.rating-row');
        const host = target.closest('#adv-rating-inline-panel, #adv-rating-modal, #perf-rating-modal, #adv-rating-performer-side-panel');
        if (!row || !host || !row.dataset.arCriterionId) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const domainName = row.dataset.arDomain;
        const entityId = row.dataset.arEntityId;
        const criterionId = row.dataset.arCriterionId;
        const rating = ratingKey(domainName, criterionId);
        const notApplicable = naKey(domainName, criterionId);
        let input;

        if (zero) input = { partial: { [rating]: 0 }, remove: [notApplicable] };
        else if (star) {
            const score = Array.from(row.querySelectorAll('.rating-star')).indexOf(star) + 1;
            if (score < 1 || score > 5) return;
            input = { partial: { [rating]: score }, remove: [notApplicable] };
        } else if (clear) input = { remove: [rating, notApplicable] };
        else input = row.classList.contains('ar-not-applicable')
            ? { remove: [rating, notApplicable] }
            : { partial: { [notApplicable]: true }, remove: [rating] };

        host.classList.add('ar-saving');
        try {
            await updateCustomFields(domainName, entityId, input);
            await new Promise(resolve => setTimeout(resolve, 150));
            await decorateHost(host);
        } catch (e) {
            console.error('[advancedRating] structured rating update failed', e);
            alert('Advanced Rating could not save this rating. Check the Stash log/browser console.');
        } finally {
            host.classList.remove('ar-saving');
        }
    }

    document.addEventListener('click', handleAction, true);
    new MutationObserver(scheduleDecorate).observe(document.documentElement, { childList: true, subtree: true });
    if (typeof PluginApi !== 'undefined' && PluginApi.Event) {
        PluginApi.Event.addEventListener('stash:location', () => { configCache = null; scheduleDecorate(); });
    }
    scheduleDecorate();
})();
