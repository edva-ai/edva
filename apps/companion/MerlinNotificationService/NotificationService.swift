import UserNotifications
import Intents

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        guard let bestAttemptContent = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // Create sender persona so Siri announces "Merlin says: <message>"
        let sender = INPerson(
            personHandle: INPersonHandle(value: "merlin@assistant", type: .unknown),
            nameComponents: nil,
            displayName: "Merlin",
            image: nil,
            contactIdentifier: nil,
            customIdentifier: "merlin-assistant"
        )

        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: bestAttemptContent.body,
            speakableGroupName: nil,
            conversationIdentifier: "merlin-chat",
            serviceName: nil,
            sender: sender,
            attachments: nil
        )

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)

        do {
            let updatedContent = try bestAttemptContent.updating(from: intent)
            contentHandler(updatedContent)
        } catch {
            contentHandler(bestAttemptContent)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
