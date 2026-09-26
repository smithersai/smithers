package services

import "time"

// Stripe value types remain part of the private-adapter seam. The OSS backend
// intentionally does not ship a payment client; Plue owns that implementation.
type StripeCreateCustomerInput struct {
	Name, Email string
	Metadata    map[string]string
}
type StripeCreateCheckoutSessionInput struct {
	CustomerID, SuccessURL, CancelURL, PriceID string
	Quantity                                   int64
	CheckoutGeneration                         string
	Metadata                                   map[string]string
	// TermsOfServiceAcceptance is the automatic-renewal disclosure (California
	// BPC §17602). The adapter must require the Terms of Service checkbox
	// (consent_collection.terms_of_service=required) and show this text beside
	// it (custom_text.terms_of_service_acceptance.message).
	TermsOfServiceAcceptance string
}
type StripeCreatePortalSessionInput struct{ CustomerID, ReturnURL string }
type StripeCheckoutSessionResult struct{ ID, URL string }
type StripeCheckoutSessionSnapshot struct {
	ID, URL, Status, SubscriptionID string
	Metadata                        map[string]string
}
type StripeSubscriptionSnapshot struct {
	ID, CustomerID, PriceID, PlanKey, Interval, Status         string
	Quantity                                                   int64
	TrialEnd, CurrentPeriodStart, CurrentPeriodEnd, CanceledAt time.Time
	CancelAtPeriodEnd                                          bool
	Metadata                                                   map[string]string
	RawPayload                                                 []byte
}
type StripeChargeSnapshot struct {
	ID, CustomerID, PaymentIntent string
	AmountRefunded                int64
	Currency                      string
}
