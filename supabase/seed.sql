insert into topics (name, keywords, canonical_themes, tags, category) values
('Code review',
  array['code review','pull request review','automated code review','false positive','review bot'],
  array['False positives / noisy automated comments','Slow review turnaround','Review culture and feedback tone','Large PRs and reviewer fatigue','AI code review quality','Review tooling integration'],
  array['code-review'], 'core'),
('CI/CD automation',
  array['github actions','ci/cd','continuous integration','flaky tests','ci pipeline'],
  array['Flaky tests','Slow pipelines','CI configuration complexity','Build failures hard to debug','Secrets and permissions','CI cost'],
  array['github-actions','continuous-integration'], 'core'),
('Developer workflow',
  array['developer productivity','developer workflow','developer experience','merge conflicts','context switching'],
  array['Context switching and interruptions','Merge conflicts and branching','Onboarding and documentation','Tooling sprawl','Process and meeting overhead'],
  '{}', 'adjacent');
