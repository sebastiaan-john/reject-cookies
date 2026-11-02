// Reads one DialogSnapshot JSON per stdin line and prints one JSON reply per line:
// `{"decision": {...}, "ms": 1234}` or `{"error": "..."}`.
// Lets web/scripts/e2e.ts drive the same ConsentDecider the Safari extension uses, outside Safari.
import Foundation

struct Decision: Encodable {
    var kind: String
    var target: Int
    var turnOff: [Int]
}

struct Reply: Encodable {
    var decision: Decision?
    var ms: Int?
    var error: String?
}

func emit(_ reply: Reply) {
    print(String(decoding: (try? JSONEncoder().encode(reply)) ?? Data(#"{"error":"encoding"}"#.utf8), as: UTF8.self))
    fflush(stdout)
}

while let line = readLine() {
    do {
        let dialog = try JSONDecoder().decode(DialogSnapshot.self, from: Data(line.utf8))
        let started = ContinuousClock.now
        let decision = try await ConsentDecider.decide(dialog)
        let ms = Int((ContinuousClock.now - started) / .milliseconds(1))
        emit(Reply(decision: Decision(kind: decision.kind.rawValue, target: decision.target, turnOff: decision.turnOff), ms: ms))
    } catch {
        emit(Reply(error: String(describing: error)))
    }
}
