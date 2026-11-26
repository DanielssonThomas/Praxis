export function skillEvaluation(skillId, version = 1) {
  return {
    id: skillId + "-replay",
    version: "1",
    skill: { id: skillId, version: String(version) },
    profiles: [],
    fixture: "tests/fixtures/projection-replay",
    prompt: "Compare the visible result after restart with the persisted value.",
    principleIds: ["AX-04", "AX-06"],
    requiredCapabilities: [],
    assertions: [{
      id: "fresh-projection",
      description: "Verify that the reopened process derives its visible value from persisted state.",
      grader: "review.knowledge-scope",
      required: true,
    }],
  };
}
