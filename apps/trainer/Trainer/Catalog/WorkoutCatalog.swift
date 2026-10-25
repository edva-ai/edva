import Foundation

// MARK: - Workout type

enum WorkoutType: String, Codable, CaseIterable, Identifiable, Sendable {
    case strengthA, strengthB
    case bodyweightA, bodyweightB
    case minimumEffective
    case cardioSteady, cardioIntervals
    case rest

    var id: String { rawValue }

    var isGymWorkout: Bool {
        switch self {
        case .strengthA, .strengthB: true
        default: false
        }
    }

    var isRest: Bool { self == .rest }
}

// MARK: - Exercise units

enum SetUnit: String, Codable, Sendable {
    case reps, seconds, minutes, steps, rounds
}

// MARK: - Exercise spec

struct ExerciseSpec: Identifiable, Hashable, Sendable {
    let id: String           // stable slug, also matches image asset name
    let name: String
    let alternativeNames: [String]
    let description: String
    let pair: Int?           // pair grouping (1, 2, 3) or nil
    let sets: Int            // default sets (user can override)
    let repsLow: Int?
    let repsHigh: Int?
    let unit: SetUnit
    let weighted: Bool
    let bilateral: Bool      // track each side separately

    var displayName: String {
        alternativeNames.isEmpty ? name : "\(name) / \(alternativeNames.joined(separator: " / "))"
    }

    var targetLabel: String {
        switch unit {
        case .reps:
            if let lo = repsLow, let hi = repsHigh, lo != hi { "\(sets) × \(lo)–\(hi) reps" }
            else if let lo = repsLow { "\(sets) × \(lo) reps" }
            else { "\(sets) sets" }
        case .seconds:
            if let lo = repsLow, let hi = repsHigh, lo != hi { "\(sets) × \(lo)–\(hi)s" }
            else if let lo = repsLow { "\(sets) × \(lo)s" }
            else { "\(sets) sets" }
        case .minutes:
            if let lo = repsLow { "\(lo) min" } else { "\(sets) sets" }
        case .steps:
            if let lo = repsLow, let hi = repsHigh, lo != hi { "\(sets) × \(lo)–\(hi) steps" }
            else if let lo = repsLow { "\(sets) × \(lo) steps" }
            else { "\(sets) sets" }
        case .rounds:
            if let lo = repsLow { "\(lo) rounds" } else { "\(sets) sets" }
        }
    }
}

// MARK: - Workout spec

struct WorkoutSpec: Identifiable, Hashable, Sendable {
    let id: WorkoutType
    let title: String
    let subtitle: String
    let warmup: String
    let howToDoIt: [String]
    let restBetweenPairsSeconds: ClosedRange<Int>
    let exercises: [ExerciseSpec]

    var restDefaultSeconds: Int {
        (restBetweenPairsSeconds.lowerBound + restBetweenPairsSeconds.upperBound) / 2
    }
}

// MARK: - Catalog

enum WorkoutCatalog {

    static let all: [WorkoutSpec] = [
        strengthA, strengthB,
        bodyweightA, bodyweightB,
        minimumEffective,
        cardioSteady, cardioIntervals,
        rest
    ]

    static func spec(for type: WorkoutType) -> WorkoutSpec {
        all.first { $0.id == type } ?? rest
    }

    // MARK: Strength A (Gym)

    static let strengthA = WorkoutSpec(
        id: .strengthA,
        title: "Strength A",
        subtitle: "Full-body gym workout",
        warmup: "5 minutes easy treadmill or stationary bike, then one light practice set of the first two exercises.",
        howToDoIt: [
            "The routine focuses on the biggest return for time invested: legs, pushing, pulling, hip hinge, carries, calf strength, and balance.",
            "Perform the exercises in each group one after the other, then rest 60–90 seconds.",
            "If an exercise bothers a joint, shorten the range or choose the easier option.",
            "When you reach the top of the rep range for all sets, increase the load slightly next time."
        ],
        restBetweenPairsSeconds: 60...90,
        exercises: [
            ExerciseSpec(
                id: "strength_a_goblet_squat",
                name: "Goblet Squat",
                alternativeNames: ["Smith Squat to Box"],
                description: "Stand tall, lower with control, and stand back up. Use a box or bench if needed for confidence and depth.",
                pair: 1, sets: 2, repsLow: 6, repsHigh: 10, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_a_incline_pushup",
                name: "Incline Push-Up on Smith Bar",
                alternativeNames: ["Dumbbell Floor Press"],
                description: "Keep your body straight and press smoothly. Pick the version that feels safe on your shoulders.",
                pair: 1, sets: 2, repsLow: 8, repsHigh: 12, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_a_one_arm_row",
                name: "One-Arm Dumbbell Row",
                alternativeNames: ["Inverted Row on Smith Bar"],
                description: "Pull your elbow toward your hip and squeeze your upper back.",
                pair: 2, sets: 2, repsLow: 8, repsHigh: 12, unit: .reps, weighted: true, bilateral: true
            ),
            ExerciseSpec(
                id: "strength_a_romanian_deadlift",
                name: "Romanian Deadlift",
                alternativeNames: ["Dumbbell or Smith RDL"],
                description: "Push your hips back, keep a long spine, and feel the work in your glutes and hamstrings.",
                pair: 2, sets: 2, repsLow: 6, repsHigh: 10, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_a_farmer_carry",
                name: "Farmer Carry",
                alternativeNames: ["Suitcase Carry"],
                description: "Walk tall while holding weight in one or both hands. Great for grip, core, and posture.",
                pair: 3, sets: 2, repsLow: 30, repsHigh: 45, unit: .seconds, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_a_calf_raise",
                name: "Standing Calf Raise",
                alternativeNames: [],
                description: "Rise up onto your toes slowly, then lower under control.",
                pair: 3, sets: 2, repsLow: 12, repsHigh: 20, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_a_single_leg_stand",
                name: "Single-Leg Stand",
                alternativeNames: [],
                description: "Stand near support if needed. Focus on balance and steady breathing.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 40, unit: .seconds, weighted: false, bilateral: true
            )
        ]
    )

    // MARK: Strength B (Gym)

    static let strengthB = WorkoutSpec(
        id: .strengthB,
        title: "Strength B",
        subtitle: "Full-body gym workout",
        warmup: "5 minutes easy treadmill or stationary bike, then one light practice set of the first two exercises.",
        howToDoIt: [
            "This routine builds leg strength, overhead pushing, pulling, grip strength, core control, calf strength, and balance.",
            "Perform the exercises in each group one after the other, then rest 60–90 seconds.",
            "Choose a weight that feels challenging but still leaves 1–2 good reps in reserve.",
            "When you reach the top of the rep range with good form, increase the load slightly next time."
        ],
        restBetweenPairsSeconds: 60...90,
        exercises: [
            ExerciseSpec(
                id: "strength_b_split_squat",
                name: "Split Squat",
                alternativeNames: ["Reverse Lunge"],
                description: "Use support if needed. Lower with control and push through the front foot to stand tall.",
                pair: 1, sets: 2, repsLow: 6, repsHigh: 10, unit: .reps, weighted: true, bilateral: true
            ),
            ExerciseSpec(
                id: "strength_b_overhead_press",
                name: "Dumbbell Overhead Press",
                alternativeNames: [],
                description: "Press overhead with control and keep your ribs down. Use a seated version if that feels better.",
                pair: 1, sets: 2, repsLow: 8, repsHigh: 12, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_b_one_arm_row",
                name: "One-Arm Dumbbell Row",
                alternativeNames: ["Inverted Row on Smith Bar"],
                description: "Pull your elbow toward your hip and squeeze your upper back.",
                pair: 2, sets: 2, repsLow: 8, repsHigh: 12, unit: .reps, weighted: true, bilateral: true
            ),
            ExerciseSpec(
                id: "strength_b_glute_bridge",
                name: "Glute Bridge",
                alternativeNames: ["Hip Thrust"],
                description: "Drive through your heels, squeeze your glutes, and avoid over-arching your lower back.",
                pair: 2, sets: 2, repsLow: 8, repsHigh: 15, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_b_side_plank",
                name: "Side Plank",
                alternativeNames: ["Dead Bug"],
                description: "Choose the version that lets you keep your trunk steady and controlled.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 40, unit: .seconds, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "strength_b_calf_raise",
                name: "Standing Calf Raise",
                alternativeNames: [],
                description: "Rise onto your toes slowly, then lower under control.",
                pair: 3, sets: 2, repsLow: 12, repsHigh: 20, unit: .reps, weighted: true, bilateral: false
            ),
            ExerciseSpec(
                id: "strength_b_tandem_walk",
                name: "Tandem Walk",
                alternativeNames: ["Heel-to-Toe Walk"],
                description: "Walk slowly in a straight line. Use a wall for support if needed.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 30, unit: .steps, weighted: false, bilateral: false
            )
        ]
    )

    // MARK: Bodyweight A

    static let bodyweightA = WorkoutSpec(
        id: .bodyweightA,
        title: "Bodyweight A",
        subtitle: "No-gym workout you can do almost anywhere",
        warmup: "3–5 minutes brisk walking, marching in place, or easy stair climbing, then gentle arm circles and 5 practice squats.",
        howToDoIt: [
            "This routine covers squatting, single-leg work, glute strength, upper-back work, core stability, calf strength, and balance.",
            "Perform the exercises in each group one after the other, then rest 45–75 seconds.",
            "If a movement feels too easy, slow down the lowering phase or add a pause at the hardest point.",
            "If a movement feels too hard, shorten the range and use more support.",
            "Move slowly, use support when needed, and stop each set with 1–2 good reps still in reserve."
        ],
        restBetweenPairsSeconds: 45...75,
        exercises: [
            ExerciseSpec(
                id: "bodyweight_a_chair_squat",
                name: "Chair Squat",
                alternativeNames: ["Sit-to-Stand"],
                description: "Sit back to a chair or box, then stand up tall. Use your hands a little if needed.",
                pair: 1, sets: 3, repsLow: 8, repsHigh: 15, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_a_wall_pushup",
                name: "Wall or Counter Push-Up",
                alternativeNames: [],
                description: "Keep your body straight and press away from the wall or counter with control.",
                pair: 1, sets: 3, repsLow: 8, repsHigh: 15, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_a_supported_split_squat",
                name: "Supported Split Squat",
                alternativeNames: [],
                description: "Hold a chair or wall for balance if needed. Lower with control and push up through the front leg.",
                pair: 2, sets: 2, repsLow: 6, repsHigh: 10, unit: .reps, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "bodyweight_a_glute_bridge",
                name: "Glute Bridge",
                alternativeNames: [],
                description: "Press through your heels and squeeze your glutes at the top.",
                pair: 2, sets: 3, repsLow: 10, repsHigh: 20, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_a_snow_angel",
                name: "Prone Reverse Snow Angel",
                alternativeNames: ["Y-T-W Raise"],
                description: "Lie face down and move your arms slowly to strengthen the upper back and shoulders.",
                pair: 3, sets: 2, repsLow: 10, repsHigh: 15, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_a_side_plank",
                name: "Side Plank",
                alternativeNames: [],
                description: "Keep a straight line from head to knees or feet. Choose the easier version if needed.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 30, unit: .seconds, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "bodyweight_a_calf_raise",
                name: "Standing Calf Raise",
                alternativeNames: [],
                description: "Rise up onto your toes slowly, then lower under control.",
                pair: 3, sets: 2, repsLow: 12, repsHigh: 20, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_a_single_leg_balance",
                name: "Single-Leg Balance",
                alternativeNames: [],
                description: "Stand near support if needed. Focus on steady breathing and good posture.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 40, unit: .seconds, weighted: false, bilateral: true
            )
        ]
    )

    // MARK: Bodyweight B

    static let bodyweightB = WorkoutSpec(
        id: .bodyweightB,
        title: "Bodyweight B",
        subtitle: "No-gym workout you can do almost anywhere",
        warmup: "3–5 minutes brisk walking, marching in place, or easy stair climbing, then a few practice lunges or supported split squats.",
        howToDoIt: [
            "This routine adds stepping, pushing, single-leg work, hip hinge or glute work, core control, calf strength, and balance.",
            "Perform the exercises in each group one after the other, then rest 45–75 seconds.",
            "If an exercise is too easy, slow it down or add a pause at the hardest point.",
            "Move with control and stop each set with 1–2 good reps still in reserve."
        ],
        restBetweenPairsSeconds: 45...75,
        exercises: [
            ExerciseSpec(
                id: "bodyweight_b_step_ups",
                name: "Step-Ups on Stairs",
                alternativeNames: ["Easy Stair Climbing"],
                description: "Use a rail if needed. Move steadily and focus on smooth steps.",
                pair: 1, sets: 1, repsLow: 5, repsHigh: 10, unit: .minutes, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_b_pushup",
                name: "Push-Up Progression",
                alternativeNames: [],
                description: "Choose wall push-ups, counter push-ups, or a lower incline depending on your strength.",
                pair: 1, sets: 3, repsLow: 8, repsHigh: 15, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_b_reverse_lunge",
                name: "Reverse Lunge",
                alternativeNames: ["Supported Split Squat"],
                description: "Use a wall or chair for balance if needed. Lower with control and stand tall.",
                pair: 2, sets: 2, repsLow: 6, repsHigh: 10, unit: .reps, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "bodyweight_b_single_leg_glute_bridge",
                name: "Single-Leg Glute Bridge",
                alternativeNames: ["Slow Hip-Hinge Good Morning"],
                description: "Choose the version that lets you feel your glutes and hamstrings without back strain.",
                pair: 2, sets: 2, repsLow: 8, repsHigh: 15, unit: .reps, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "bodyweight_b_bird_dog",
                name: "Bird Dog",
                alternativeNames: ["Dead Bug"],
                description: "Move slowly and keep your trunk steady. The goal is control, not speed.",
                pair: 3, sets: 2, repsLow: 8, repsHigh: 12, unit: .reps, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "bodyweight_b_calf_raise",
                name: "Standing Calf Raise",
                alternativeNames: [],
                description: "Rise onto your toes slowly and lower with control.",
                pair: 3, sets: 2, repsLow: 12, repsHigh: 20, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "bodyweight_b_tandem_walk",
                name: "Tandem Walk",
                alternativeNames: ["Heel-to-Toe Walk"],
                description: "Walk in a straight line and use support if needed.",
                pair: 3, sets: 2, repsLow: 20, repsHigh: 30, unit: .steps, weighted: false, bilateral: false
            )
        ]
    )

    // MARK: Minimum Effective

    static let minimumEffective = WorkoutSpec(
        id: .minimumEffective,
        title: "Minimum Effective",
        subtitle: "Your best busy-day plan",
        warmup: "Take 1–2 minutes to walk around, march in place, or climb a few stairs. Then begin the circuit.",
        howToDoIt: [
            "Perfect for travel days, busy weeks, or any day you want a simple win.",
            "Do 1 round when time is tight. Do 2 rounds if you have 15–20 minutes.",
            "Move briskly, but never rush your form.",
            "This is the minimum plan that still checks the important boxes: legs, push, glutes, calf strength, core, balance, and cardio."
        ],
        restBetweenPairsSeconds: 20...40,
        exercises: [
            ExerciseSpec(
                id: "minimum_sit_to_stand",
                name: "Sit-to-Stand",
                alternativeNames: [],
                description: "Stand up from a chair, then sit back down with control.",
                pair: nil, sets: 1, repsLow: 10, repsHigh: 10, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "minimum_wall_pushup",
                name: "Wall or Counter Push-Up",
                alternativeNames: [],
                description: "Keep your body straight and press smoothly.",
                pair: nil, sets: 1, repsLow: 8, repsHigh: 12, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "minimum_split_squat",
                name: "Split Squat",
                alternativeNames: [],
                description: "Hold support if needed and lower with control.",
                pair: nil, sets: 1, repsLow: 8, repsHigh: 8, unit: .reps, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "minimum_glute_bridge",
                name: "Glute Bridge",
                alternativeNames: [],
                description: "Drive through your heels and squeeze your glutes at the top.",
                pair: nil, sets: 1, repsLow: 12, repsHigh: 12, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "minimum_calf_raise",
                name: "Standing Calf Raise",
                alternativeNames: [],
                description: "Rise up onto your toes slowly, then lower under control.",
                pair: nil, sets: 1, repsLow: 20, repsHigh: 20, unit: .reps, weighted: false, bilateral: false
            ),
            ExerciseSpec(
                id: "minimum_side_plank",
                name: "Side Plank",
                alternativeNames: [],
                description: "Choose the easier version if needed and keep your trunk steady.",
                pair: nil, sets: 1, repsLow: 20, repsHigh: 30, unit: .seconds, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "minimum_single_leg_stand",
                name: "Single-Leg Stand",
                alternativeNames: [],
                description: "Stand near support if needed.",
                pair: nil, sets: 1, repsLow: 20, repsHigh: 20, unit: .seconds, weighted: false, bilateral: true
            ),
            ExerciseSpec(
                id: "minimum_brisk_walk",
                name: "Brisk Walk or Stairs",
                alternativeNames: [],
                description: "Finish with a fast walk, treadmill, or a few minutes of stairs.",
                pair: nil, sets: 1, repsLow: 10, repsHigh: 10, unit: .minutes, weighted: false, bilateral: false
            )
        ]
    )

    // MARK: Cardio Steady

    static let cardioSteady = WorkoutSpec(
        id: .cardioSteady,
        title: "Cardio: Steady",
        subtitle: "Treadmill incline walk or stationary bike",
        warmup: "A few easy minutes to settle in.",
        howToDoIt: [
            "Cardio supports heart health, stamina, weight control, and overall energy.",
            "Best for base fitness and endurance.",
            "Good choice on recovery days.",
            "Aim for a smooth, continuous effort — you can still talk in short sentences.",
            "Once you are consistent, increase time or pace slightly."
        ],
        restBetweenPairsSeconds: 0...0,
        exercises: [
            ExerciseSpec(
                id: "cardio_steady",
                name: "Steady State",
                alternativeNames: ["Incline Walk or Bike"],
                description: "After a few easy minutes, settle into a moderate pace you can sustain. You should feel like you are working but still able to talk in short sentences.",
                pair: nil, sets: 1, repsLow: 25, repsHigh: 35, unit: .minutes, weighted: false, bilateral: false
            )
        ]
    )

    // MARK: Cardio Intervals

    static let cardioIntervals = WorkoutSpec(
        id: .cardioIntervals,
        title: "Cardio: Intervals",
        subtitle: "Bike or treadmill intervals — ~28 minutes",
        warmup: "5 minutes easy warm-up.",
        howToDoIt: [
            "Cardio supports heart health, stamina, weight control, and overall energy.",
            "8 rounds of 1 minute hard / 1 minute easy, with 5 minutes easy warm-up and cool-down (about 28 minutes total).",
            "Hard minutes feel challenging but controlled — do not sprint all-out.",
            "The easy minutes are for recovery, not rest.",
            "Bike is often easier on the joints than the treadmill."
        ],
        restBetweenPairsSeconds: 0...0,
        exercises: [
            ExerciseSpec(
                id: "cardio_intervals",
                name: "Intervals",
                alternativeNames: ["8 × 1 min hard / 1 min easy"],
                description: "5 min easy warm-up · 8 rounds of (1 min hard + 1 min easy) · 5 min easy cool-down.",
                pair: nil, sets: 8, repsLow: 1, repsHigh: 1, unit: .rounds, weighted: false, bilateral: false
            )
        ]
    )

    // MARK: Rest

    static let rest = WorkoutSpec(
        id: .rest,
        title: "Rest Day",
        subtitle: "Recover and come back stronger.",
        warmup: "",
        howToDoIt: [
            "Walking, mobility, and easy stretching are great.",
            "Sleep and hydration do more for recovery than any supplement."
        ],
        restBetweenPairsSeconds: 0...0,
        exercises: []
    )
}
