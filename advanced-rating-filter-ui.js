// Advanced Rating numeric filters for Stash scene/performer list sidebars.
// Uses Stash's native custom_fields criterion so filtering stays server-side
// and saved-filter compatible.

(function () {
  'use strict';

  if (typeof PluginApi === 'undefined' || !PluginApi.React || !PluginApi.patch) return;

  const React = PluginApi.React;
  const PLUGIN_ID = 'advancedRating';
  const TYPE = 'custom_fields';
  const PREFIX = 'advancedRating';

  const DOMAIN_DEFAULTS = {
    scene: {
      prefix: 'scene_',
      groups: [{ id: 'overall', name: 'Overall' }],
      criteria: [
        { id: 'production_quality', name: 'Production Quality', group: 'overall', enabled: true },
        { id: 'chemistry', name: 'Chemistry', group: 'overall', enabled: true },
        { id: 'performance', name: 'Performance', group: 'overall', enabled: true },
        { id: 'aesthetics', name: 'Aesthetics', group: 'overall', enabled: true },
        { id: 'creativity', name: 'Creativity', group: 'overall', enabled: true },
      ],
    },
    performer: {
      prefix: 'performer_',
      groups: [
        { id: 'physical', name: 'Physical' },
        { id: 'performance', name: 'Performance' },
      ],
      criteria: [
        { id: 'face', name: 'Face', group: 'physical', enabled: true },
        { id: 'breasts', name: 'Breasts', group: 'physical', enabled: true },
        { id: 'ass', name: 'Ass', group: 'physical', enabled: true },
        { id: 'body', name: 'Body Overall', group: 'physical', enabled: true },
        { id: 'genitals', name: 'Genitals', group: 'physical', enabled: true },
        { id: 'technique', name: 'Technique', group: 'performance', enabled: true },
        { id: 'energy', name: 'Energy & Presence', group: 'performance', enabled: true },
        { id: 'sluttiness', name: 'Sluttiness', group: 'performance', enabled: true },
      ],
    },
  };

  let configPromise = null;

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

  function boolValue(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    return fallback;
  }

  async function getConfig() {
    if (!configPromise) {
      configPromise = gql('query { configuration { plugins } }')
        .then(data => (data.configuration && data.configuration.plugins && data.configuration.plugins[PLUGIN_ID]) || {})
        .catch(error => {
          configPromise = null;
          throw error;
        });
    }
    return configPromise;
  }

  function modelFromConfig(config, domainName) {
    const defaults = DOMAIN_DEFAULTS[domainName];
    const p = defaults.prefix;
    const groupIDs = typeof config[p + 'group_ids'] === 'string'
      ? config[p + 'group_ids'].split(',').map(v => v.trim()).filter(Boolean)
      : defaults.groups.map(g => g.id);
    const groups = groupIDs.map(id => {
      const def = defaults.groups.find(g => g.id === id);
      return { id, name: config[p + 'group_name_' + id] || (def ? def.name : id) };
    });
    const firstGroup = groups[0] ? groups[0].id : 'overall';
    const criterionIDs = typeof config[p + 'criteria_ids'] === 'string'
      ? config[p + 'criteria_ids'].split(',').map(v => v.trim()).filter(Boolean)
      : defaults.criteria.map(c => c.id);
    const criteria = criterionIDs.map(id => {
      const def = defaults.criteria.find(c => c.id === id);
      return {
        id,
        name: config[p + 'name_' + id] || (def ? def.name : id),
        group: config[p + 'group_' + id] || (def ? def.group : firstGroup),
        enabled: boolValue(config[p + 'enabled_' + id], def ? def.enabled : true),
      };
    }).filter(c => c.enabled);
    return { groups, criteria };
  }

  function fieldFor(domainName, criterionID) {
    return `${PREFIX}.${domainName}.rating.${criterionID}`;
  }

  function isManagedField(domainName, field) {
    return typeof field === 'string' && field.startsWith(`${PREFIX}.${domainName}.rating.`);
  }

  function findFilterProps(children) {
    let found = null;
    React.Children.forEach(children, child => {
      if (found || !child || !child.props) return;
      if (child.props.filter && typeof child.props.setFilter === 'function') {
        found = { filter: child.props.filter, setFilter: child.props.setFilter };
        return;
      }
      if (child.props.children) found = findFilterProps(child.props.children);
    });
    return found;
  }

  function getCustomFieldValues(filter) {
    const criteria = typeof filter.criteriaFor === 'function' ? filter.criteriaFor(TYPE) : [];
    const criterion = criteria && criteria[0];
    return criterion && Array.isArray(criterion.value) ? criterion.value.slice() : [];
  }

  function setCustomFieldValues(filter, setFilter, values) {
    const criterion = filter.makeCriterion(TYPE);
    criterion.value = values;
    const next = values.length
      ? filter.replaceCriteria(TYPE, [criterion])
      : filter.replaceCriteria(TYPE, []);
    setFilter(next);
  }

  function buildNativeCriteria(field, operator, value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 5) return [];
    if (operator === '=') return [{ field, value: [numeric], modifier: 'EQUALS' }];
    if (operator === '<') return [{ field, value: [numeric], modifier: 'LESS_THAN' }];
    if (operator === '>') return [{ field, value: [numeric], modifier: 'GREATER_THAN' }];
    if (operator === '!=') {
      // Native NOT_EQUALS intentionally includes NULL. Add NOT_NULL so
      // Unrated and N/A remain distinct from numeric values.
      return [
        { field, value: [numeric], modifier: 'NOT_EQUALS' },
        { field, modifier: 'NOT_NULL' },
      ];
    }
    return [];
  }

  function inferManagedFilters(domainName, values, model) {
    const byField = new Map();
    values.forEach(v => {
      if (!isManagedField(domainName, v.field)) return;
      if (!byField.has(v.field)) byField.set(v.field, []);
      byField.get(v.field).push(v);
    });
    const result = [];
    for (const [field, parts] of byField.entries()) {
      const id = field.slice(`${PREFIX}.${domainName}.rating.`.length);
      const criterion = model.criteria.find(c => c.id === id);
      if (!criterion) continue;
      const group = model.groups.find(g => g.id === criterion.group);
      const main = parts.find(p => p.modifier !== 'NOT_NULL');
      if (!main) continue;
      let operator = null;
      if (main.modifier === 'EQUALS') operator = '=';
      else if (main.modifier === 'NOT_EQUALS' && parts.some(p => p.modifier === 'NOT_NULL')) operator = '!=';
      else if (main.modifier === 'LESS_THAN') operator = '<';
      else if (main.modifier === 'GREATER_THAN') operator = '>';
      if (!operator || !main.value || main.value.length !== 1) continue;
      result.push({
        field,
        label: `${group ? group.name : criterion.group} → ${criterion.name}`,
        operator,
        value: main.value[0],
      });
    }
    return result;
  }

  function AdvancedRatingFilterSection({ domainName, filter, setFilter }) {
    const [model, setModel] = React.useState(null);
    const [criterionID, setCriterionID] = React.useState('');
    const [operator, setOperator] = React.useState('=');
    const [value, setValue] = React.useState('4');

    React.useEffect(() => {
      let live = true;
      getConfig().then(config => {
        if (!live) return;
        const next = modelFromConfig(config, domainName);
        setModel(next);
        if (!criterionID && next.criteria[0]) setCriterionID(next.criteria[0].id);
      }).catch(error => console.warn('[advancedRating] filter config load failed', error));
      return () => { live = false; };
    }, [domainName]);

    if (!model) return null;

    const allValues = getCustomFieldValues(filter);
    const active = inferManagedFilters(domainName, allValues, model);

    function addFilter() {
      if (!criterionID) return;
      const field = fieldFor(domainName, criterionID);
      const preserved = allValues.filter(v => v.field !== field);
      const additions = buildNativeCriteria(field, operator, value);
      if (!additions.length) return;
      setCustomFieldValues(filter, setFilter, [...preserved, ...additions]);
    }

    function removeFilter(field) {
      setCustomFieldValues(filter, setFilter, allValues.filter(v => v.field !== field));
    }

    const optionGroups = model.groups.map(group => {
      const children = model.criteria.filter(c => c.group === group.id).map(c =>
        React.createElement('option', { key: c.id, value: c.id }, c.name)
      );
      return children.length ? React.createElement('optgroup', { key: group.id, label: group.name }, children) : null;
    });

    return React.createElement('section', { className: 'advanced-rating-filter-section' },
      React.createElement('div', { className: 'advanced-rating-filter-title' }, 'Advanced Rating'),
      React.createElement('div', { className: 'advanced-rating-filter-controls' },
        React.createElement('select', {
          className: 'form-control btn-secondary advanced-rating-filter-criterion',
          value: criterionID,
          onChange: e => setCriterionID(e.target.value),
          'aria-label': 'Advanced Rating criterion',
        }, optionGroups),
        React.createElement('select', {
          className: 'form-control btn-secondary advanced-rating-filter-operator',
          value: operator,
          onChange: e => setOperator(e.target.value),
          'aria-label': 'Advanced Rating operator',
        }, ['=', '!=', '<', '>'].map(op => React.createElement('option', { key: op, value: op }, op))),
        React.createElement('select', {
          className: 'form-control btn-secondary advanced-rating-filter-value',
          value,
          onChange: e => setValue(e.target.value),
          'aria-label': 'Advanced Rating value',
        }, [0, 1, 2, 3, 4, 5].map(n => React.createElement('option', { key: n, value: String(n) }, String(n)))),
        React.createElement('button', { type: 'button', className: 'btn btn-primary', onClick: addFilter }, 'Add')
      ),
      active.length
        ? React.createElement('div', { className: 'advanced-rating-filter-active' }, active.map(item =>
            React.createElement('div', { key: item.field, className: 'advanced-rating-filter-pill' },
              React.createElement('span', null, `${item.label} ${item.operator} ${item.value}`),
              React.createElement('button', {
                type: 'button',
                className: 'advanced-rating-filter-remove',
                title: 'Remove Advanced Rating filter',
                onClick: () => removeFilter(item.field),
              }, '×')
            )
          ))
        : React.createElement('div', { className: 'advanced-rating-filter-empty' }, 'No Advanced Rating filters applied.')
    );
  }

  function patchSidebar(componentName, domainName) {
    PluginApi.patch.after(componentName, function (props, result) {
      try {
        const fp = findFilterProps(props && props.children);
        if (!fp || !result || !result.props) return result;
        const existing = React.Children.toArray(result.props.children);
        const section = React.createElement(AdvancedRatingFilterSection, {
          key: `advanced-rating-${domainName}-filters`,
          domainName,
          filter: fp.filter,
          setFilter: fp.setFilter,
        });
        return React.cloneElement(result, result.props, [...existing, section]);
      } catch (error) {
        console.warn('[advancedRating] filter sidebar patch failed', error);
        return result;
      }
    });
  }

  patchSidebar('FilteredSceneList.SidebarSections', 'scene');
  patchSidebar('FilteredPerformerList.SidebarSections', 'performer');

  const style = document.createElement('style');
  style.id = 'advanced-rating-filter-style';
  style.textContent = `
    .advanced-rating-filter-section { border-top: 1px solid rgba(255,255,255,.12); padding: 1rem .75rem; }
    .advanced-rating-filter-title { font-weight: 600; margin-bottom: .55rem; }
    .advanced-rating-filter-controls { display: grid; grid-template-columns: minmax(0,1fr) 64px 58px auto; gap: .4rem; align-items: center; }
    .advanced-rating-filter-controls .form-control { min-width: 0; }
    .advanced-rating-filter-active { display: flex; flex-direction: column; gap: .4rem; margin-top: .65rem; }
    .advanced-rating-filter-pill { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .35rem .5rem; border-radius: .35rem; background: rgba(255,255,255,.08); font-size: .9rem; }
    .advanced-rating-filter-remove { border: 0; background: transparent; color: inherit; font-size: 1.15rem; line-height: 1; padding: 0 .15rem; }
    .advanced-rating-filter-empty { margin-top: .5rem; opacity: .7; font-size: .85rem; }
    @media (max-width: 700px) { .advanced-rating-filter-controls { grid-template-columns: 1fr 64px 58px; } .advanced-rating-filter-controls .btn { grid-column: 1 / -1; } }
  `;
  document.head.appendChild(style);
})();
