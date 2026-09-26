// Package commerce exposes the canonical billing routes without a payment SDK.
// Private deployments supply the payment transport; worker admission is separate.
package commerce

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/billingstore"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// These are value contracts, with no provider SDK dependency.
type Client = services.StripeBillingClient
type CreateCustomerInput = services.StripeCreateCustomerInput
type CreateCheckoutSessionInput = services.StripeCreateCheckoutSessionInput
type CreatePortalSessionInput = services.StripeCreatePortalSessionInput
type CheckoutSessionResult = services.StripeCheckoutSessionResult
type CheckoutSessionSnapshot = services.StripeCheckoutSessionSnapshot
type SubscriptionSnapshot = services.StripeSubscriptionSnapshot
type ChargeSnapshot = services.StripeChargeSnapshot
type EmailSender = services.BillingEmailSender
type User = db.User
type Plans = services.BillingPlansResponse
type Overview = services.BillingOverview
type Session = services.BillingSessionResult
type Capabilities = services.BillingCapabilities

// Routes is the complete existing HTTP billing contract. Optional commerce
// absence must be represented by nil, never a nonfunctional route authority.
type Routes interface {
	GetUserPlans(context.Context, *User) (Plans, error)
	GetUserOverview(context.Context, *User) (Overview, error)
	GetOrgOverview(context.Context, *User, string) (Overview, error)
	CreateUserCheckout(context.Context, *User, string, string) (Session, error)
	CreateOrgCheckout(context.Context, *User, string, string, string) (Session, error)
	CreateUserPortal(context.Context, *User) (Session, error)
	CreateOrgPortal(context.Context, *User, string) (Session, error)
	RefreshUserBilling(context.Context, *User) (Overview, error)
	RefreshOrgBilling(context.Context, *User, string) (Overview, error)
	HandleStripeWebhook(context.Context, []byte, string) error
}

type Service interface {
	Routes
	ReconcileOrgSeats(context.Context, int64) error
	Capabilities() Capabilities
	// SetFallbackEmailSender binds the common product notification service before serving.
	// A deployment-supplied sender remains authoritative.
	SetFallbackEmailSender(EmailSender)
}

type Config struct {
	Usage                                                           admission.UsageFactory
	Prices                                                          admission.Prices
	BaseURL, PortalReturnURL, CheckoutSuccessURL, CheckoutCancelURL string
	WebhookSecret                                                   string
	EmailSender                                                     EmailSender
	// MonthlyCreditGrantCents is the monthly platform credit per billing
	// account, granted in the exact credit ledger. Zero grants nothing.
	MonthlyCreditGrantCents int64
}

// New constructs API commerce over the same ledger, metering, and transactional
// projection implementation used by admission. Payment keys stay in Client.
func New(pool *pgxpool.Pool, client Client, cfg Config) (Service, error) {
	if pool == nil {
		return nil, errors.New("commerce: database pool is required")
	}
	if client == nil {
		return nil, errors.New("commerce: payment client is required")
	}
	if strings.TrimSpace(cfg.WebhookSecret) == "" {
		return nil, errors.New("commerce: webhook secret is required")
	}
	if cfg.Usage == nil {
		return nil, errors.New("commerce: usage factory is required")
	}
	queries, err := billingstore.Bind(pool, cfg.Usage)
	if err != nil {
		return nil, err
	}
	p := cfg.Prices
	service := services.NewBillingService(queries, client, services.BillingServiceConfig{
		BaseURL: cfg.BaseURL, PortalReturnURL: cfg.PortalReturnURL,
		CheckoutSuccessURL: cfg.CheckoutSuccessURL, CheckoutCancelURL: cfg.CheckoutCancelURL,
		StripeWebhookSecret:    cfg.WebhookSecret,
		PersonalMonthlyPriceID: p.PersonalMonthly, PersonalAnnualPriceID: p.PersonalAnnual,
		ProMonthlyPriceID: p.ProMonthly, ProAnnualPriceID: p.ProAnnual,
		MaxMonthlyPriceID: p.MaxMonthly, MaxAnnualPriceID: p.MaxAnnual,
		TeamMonthlyPriceID: p.TeamMonthly, TeamAnnualPriceID: p.TeamAnnual,
		EnterpriseMonthlyPriceID: p.EnterpriseMonthly, EnterpriseAnnualPriceID: p.EnterpriseAnnual,
		MonthlyCreditGrantCents: cfg.MonthlyCreditGrantCents,
	}, services.WithBillingEmailSender(cfg.EmailSender), services.WithBillingCreditLedger(credits.Ledger{DB: pool}))
	return &authority{BillingService: service, emailSender: cfg.EmailSender}, nil
}

type authority struct {
	*services.BillingService
	emailSender EmailSender
}

func (s *authority) Capabilities() Capabilities { return s.CommerceCapabilities() }

var _ Service = (*authority)(nil)
var _ admission.Policy = (*authority)(nil)

func (s *authority) SetFallbackEmailSender(sender EmailSender) {
	if s.emailSender == nil {
		s.emailSender = sender
		services.WithBillingEmailSender(sender)(s.BillingService)
	}
}
