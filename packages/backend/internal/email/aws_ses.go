package email

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

type awsSESClient struct {
	client *sesv2.Client
}

// NewSESClient creates an AWS SES v2 client using the default AWS credential chain.
func NewSESClient(ctx context.Context, region string) (SESAPI, error) {
	region = strings.TrimSpace(region)
	if region == "" {
		return nil, fmt.Errorf("email: SES region is required")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("email: load AWS config for SES: %w", err)
	}
	if _, err := cfg.Credentials.Retrieve(ctx); err != nil {
		return nil, fmt.Errorf("email: load AWS credentials for SES: %w", err)
	}
	return &awsSESClient{client: sesv2.NewFromConfig(cfg)}, nil
}

func (c *awsSESClient) SendEmail(ctx context.Context, from string, to []string, subject, htmlBody, textBody string) error {
	body := &sestypes.Body{}
	if htmlBody != "" {
		body.Html = &sestypes.Content{Data: aws.String(htmlBody)}
	}
	if textBody != "" {
		body.Text = &sestypes.Content{Data: aws.String(textBody)}
	}

	_, err := c.client.SendEmail(ctx, &sesv2.SendEmailInput{
		FromEmailAddress: aws.String(from),
		Destination: &sestypes.Destination{
			ToAddresses: to,
		},
		Content: &sestypes.EmailContent{
			Simple: &sestypes.Message{
				Subject: &sestypes.Content{Data: aws.String(subject)},
				Body:    body,
			},
		},
	})
	if err != nil {
		return fmt.Errorf("email: SES send failed: %w", err)
	}
	return nil
}
