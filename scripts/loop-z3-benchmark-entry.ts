import { init, killThreads } from "z3-solver/build/node.js";
import { solveLoop } from "../src/game/solver-loop";
import { createLoopZ3BenchmarkFixture } from "../src/game/loop-z3-fixture";
import { createLoopZ3Session, solveLoopZ3 } from "../src/game/solver-loop-z3";
import { loopSegmentsFromSignature, validateLoopPilotSolution } from "../src/game/loop-pilot-validator";

const budgetMs = 2500;
const fixture = createLoopZ3BenchmarkFixture(budgetMs);
const legacyStatus = (result: ReturnType<typeof solveLoop>) => result.timedOut ? "timeout" : result.count === 0 ? "unsat" : result.count === 1 ? "unique" : "multiple";
const signature = (result: ReturnType<typeof solveLoop>) => result.solutions[0]?.loop?.map((edge) => {
  const left = edge.from < edge.to ? edge.from : edge.to;
  const right = edge.from < edge.to ? edge.to : edge.from;
  return `${left}-${right}`;
}).sort().join("|");

const initStarted = performance.now();
const api = await init();
const z3InitMs = performance.now() - initStarted;
try {
  const encodeStarted = performance.now();
  const session = createLoopZ3Session(api, fixture);
  const encoderBuildMs = performance.now() - encodeStarted;

  const coldLegacy = solveLoop(fixture);
  const coldZ3 = await solveLoopZ3(session, budgetMs);

  // One additional untimed warm-up for each backend prevents JIT setup from
  // contaminating the seven reported warm samples.
  solveLoop(fixture);
  await solveLoopZ3(session, budgetMs);

  // If legacy exhausts the production budget, make one explicitly labelled
  // longer attempt for ground truth. A remaining timeout is a lower bound,
  // not evidence that the terminal Z3 classification is wrong.
  const legacyVerificationBudgetMs = 10000;
  const legacyVerification = solveLoop({ ...fixture, timeBudgetMs: legacyVerificationBudgetMs });
  const legacyVerificationClassification = legacyStatus(legacyVerification);

  const legacySamples: Array<Record<string, unknown>> = [];
  const z3Samples: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 7; index += 1) {
    const legacy = solveLoop(fixture);
    legacySamples.push({ index: index + 1, elapsedMs: legacy.elapsedMs, classification: legacyStatus(legacy), timedOut: legacy.timedOut, exploredNodes: legacy.exploredNodes, signature: signature(legacy) });
    const z3 = await solveLoopZ3(session, budgetMs);
    z3Samples.push({ index: index + 1, elapsedMs: z3.elapsedMs, classification: z3.classification, timedOut: z3.timedOut, checks: z3.checks, signatures: z3.signatures });
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const nearestRankP95 = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  };
  const legacyTimes = legacySamples.map((sample) => Number(sample.elapsedMs));
  const z3Times = z3Samples.map((sample) => Number(sample.elapsedMs));
  const z3Evidence = z3Samples.map((sample) => {
    const signatures = sample.signatures as string[];
    const validations = signatures.map((candidate) => validateLoopPilotSolution(fixture, loopSegmentsFromSignature(candidate)));
    const distinct = signatures.length === new Set(signatures).size;
    return { signatures, distinct, validations, valid: signatures.length === 2 && distinct && validations.every((validation) => validation.valid) };
  });
  const legacyEvidence = legacyVerification.solutions.map((solution) => validateLoopPilotSolution(fixture, solution.loop ?? []));
  const z3EvidenceValid = z3Evidence.every((evidence) => evidence.valid);
  const z3MultipleProven = z3Samples.every((sample, index) => sample.classification === "multiple" && z3Evidence[index]?.valid);
  const classificationComparable = legacyVerificationClassification !== "timeout";
  const classificationsAgree = !classificationComparable || z3Samples.every((sample) => sample.classification === legacyVerificationClassification);
  const uniqueSignaturesAgree = !classificationComparable || legacyVerificationClassification !== "unique" || legacyVerification.solutions[0]?.loop?.map((edge) => {
    const left = edge.from < edge.to ? edge.from : edge.to;
    const right = edge.from < edge.to ? edge.to : edge.from;
    return `${left}-${right}`;
  }).sort().join("|") === z3Samples[0]?.signatures?.[0];
  const z3Terminal = z3Samples.every((sample) => sample.classification !== "unknown" && sample.classification !== "timeout");
  const legacyClassification = legacySamples[0]?.classification;
  const z3Classification = z3Samples[0]?.classification;
  const warmMedian = median(z3Times);
  const legacyMedian = median(legacyTimes);
  const speedup = warmMedian === 0 ? Number.POSITIVE_INFINITY : legacyMedian / warmMedian;
  const relativeBudgetLowerBound = budgetMs / warmMedian;
  const legacyTimeoutLowerBound = legacyClassification === "timeout" && legacyVerificationClassification === "timeout";
  const thresholdSatisfied = classificationComparable ? speedup >= 3 : legacyTimeoutLowerBound && relativeBudgetLowerBound >= 3;
  const decision = z3MultipleProven && z3EvidenceValid && z3Terminal && thresholdSatisfied && (!classificationComparable || (classificationsAgree && uniqueSignaturesAgree)) ? "CONTINUE_MIGRATION" : "DO_NOT_MIGRATE";
  const result = {
    status: "PASS",
    decision,
    threshold: { warmSolveMedianSpeedup: 3, requirement: "Z3 warm median >= 3x legacy median with matching proved classification/signature" },
    environment: { node: process.version, z3: "z3-solver 5.2.0", platform: process.platform, arch: process.arch },
    fixture: { name: fixture.board.name, seed: "8x8-hamiltonian-serpentine-v1", rows: 8, columns: 8, activeCells: fixture.board.activeCells.length, rules: [...fixture.globalRuleKeys, ...fixture.clueRules.map((rule) => rule.key)] },
    budgets: { legacyMs: budgetMs, z3Ms: budgetMs, legacyVerificationMs: legacyVerificationBudgetMs, solutionLimit: fixture.solutionLimit },
    z3InitMs,
    encoderBuildMs,
    coldSolve: { legacy: { elapsedMs: coldLegacy.elapsedMs, classification: legacyStatus(coldLegacy), timedOut: coldLegacy.timedOut }, z3: { elapsedMs: coldZ3.elapsedMs, classification: coldZ3.classification, timedOut: coldZ3.timedOut, checks: coldZ3.checks } },
    warmup: { legacy: "one additional untimed solve", z3: "one additional untimed solve" },
    summary: { legacyClassification, z3Classification, legacyVerificationClassification, classificationComparable, classificationsAgree, uniqueSignaturesAgree, z3Terminal, z3MultipleProven, z3EvidenceValid, legacyTimeoutLowerBound, thresholdSatisfied, legacyMedianMs: legacyMedian, legacyP95Ms: nearestRankP95(legacyTimes), z3WarmMedianMs: warmMedian, z3WarmP95Ms: nearestRankP95(z3Times), warmSpeedup: classificationComparable ? speedup : null, relativeProductionBudgetLowerBound: legacyTimeoutLowerBound ? relativeBudgetLowerBound : null, breakEvenSolves: z3InitMs + encoderBuildMs <= Math.max(0.001, budgetMs - warmMedian) ? Math.ceil((z3InitMs + encoderBuildMs) / (budgetMs - warmMedian)) : null },
    evidence: { z3: z3Evidence.map((evidence) => ({ distinct: evidence.distinct, valid: evidence.valid, validations: evidence.validations.map((validation) => ({ valid: validation.valid, errors: validation.errors })) })), legacyVerification: legacyEvidence.map((validation) => ({ valid: validation.valid, errors: validation.errors })) },
    legacyVerification: { elapsedMs: legacyVerification.elapsedMs, classification: legacyVerificationClassification, timedOut: legacyVerification.timedOut, exploredNodes: legacyVerification.exploredNodes, signature: signature(legacyVerification) },
    legacySamples,
    z3Samples,
  };
  console.log(JSON.stringify(result));
  if ((classificationComparable && (!classificationsAgree || !uniqueSignaturesAgree)) || !z3Terminal || !z3MultipleProven || !z3EvidenceValid) process.exitCode = 1;
  // A non-three-times result is an honest migration decision, not a harness failure.
} finally {
  await killThreads(api.em);
}
