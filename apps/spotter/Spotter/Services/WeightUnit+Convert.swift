import Foundation

extension WeightUnit {
    private static let kgPerLb = 0.45359237

    /// Convert a canonical-lbs value into the user's chosen unit.
    func fromLbs(_ lbs: Double) -> Double {
        switch self {
        case .lbs: lbs
        case .kg:  lbs * Self.kgPerLb
        }
    }

    /// Convert a user-entered value (in this unit) back into canonical lbs.
    func toLbs(_ value: Double) -> Double {
        switch self {
        case .lbs: value
        case .kg:  value / Self.kgPerLb
        }
    }

    /// Stepper step size in this unit.
    var step: Double {
        switch self {
        case .lbs: 2.5
        case .kg:  1.25
        }
    }

    /// Max weight in this unit for stepper range.
    var maxWeight: Double {
        switch self {
        case .lbs: 500
        case .kg:  225
        }
    }

    /// Formatted display string.
    func format(lbs: Double) -> String {
        let value = fromLbs(lbs)
        let rounded = (value * 2).rounded() / 2
        if rounded.truncatingRemainder(dividingBy: 1) == 0 {
            return "\(Int(rounded))"
        }
        return rounded.formatted(.number.precision(.fractionLength(1)))
    }

    var shortSuffix: String {
        switch self {
        case .lbs: "lb"
        case .kg:  "kg"
        }
    }
}
