package services

import "strings"

// CommerceCapabilities reflects this actual configured account authority.
// Shared composition and the public facade use the same catalog decision.
func (s *BillingService) CommerceCapabilities() BillingCapabilities {
	if s == nil || s.stripe == nil {
		return BillingCapabilities{}
	}
	return BillingCapabilities{Overview: true, Plans: true, Checkout: s.hasCheckoutPlan(), Portal: true, Webhook: s.config.StripeWebhookSecret != ""}
}

func (s *BillingService) hasCheckoutPlan() bool {
	if s == nil || s.stripe == nil {
		return false
	}
	for _, plans := range s.checkoutPlans {
		for _, plan := range plans {
			if strings.TrimSpace(plan.PriceID) != "" {
				return true
			}
		}
	}
	return false
}
