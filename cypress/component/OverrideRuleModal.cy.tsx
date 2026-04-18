import OverrideRuleModal from '@app/components/Settings/OverrideRule/OverrideRuleModal';
import type OverrideRule from '@server/entity/OverrideRule';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { IntlProvider } from 'react-intl';
import { ToastProvider } from 'react-toast-notifications';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <IntlProvider locale="en">
    <ToastProvider>{children}</ToastProvider>
  </IntlProvider>
);

const mockTestResponse = {
  profiles: [{ id: 1, name: 'HD-1080p' }],
  rootFolders: [{ id: 1, path: '/movies' }],
  tags: [],
};

describe('OverrideRuleModal', () => {
  beforeEach(() => {
    cy.intercept('POST', '/api/v1/settings/radarr/test', mockTestResponse).as(
      'radarrTest'
    );
    cy.intercept('POST', '/api/v1/settings/sonarr/test', mockTestResponse).as(
      'sonarrTest'
    );
    cy.intercept('GET', '/api/v1/settings/main', { originalLanguage: 'en' });
  });

  it('enables dropdowns when radarrServiceId does not match array index', () => {
    const radarrServices = [
      {
        id: 3,
        name: 'Radarr',
        hostname: 'localhost',
        port: 7878,
        apiKey: 'test',
      },
    ] as RadarrSettings[];
    const rule = {
      radarrServiceId: 3,
    } as Partial<OverrideRule> as OverrideRule;

    cy.mount(
      <Wrapper>
        <OverrideRuleModal
          rule={rule}
          radarrServices={radarrServices}
          sonarrServices={[]}
          onClose={() => {}}
        />
      </Wrapper>
    );

    cy.wait('@radarrTest');
    cy.get('#rootFolderRule').should('not.be.disabled');
    cy.get('#profileIdRule').should('not.be.disabled');
  });

  it('enables dropdowns when sonarrServiceId does not match array index', () => {
    const sonarrServices = [
      {
        id: 5,
        name: 'Sonarr',
        hostname: 'localhost',
        port: 8989,
        apiKey: 'test',
      },
    ] as SonarrSettings[];
    const rule = {
      sonarrServiceId: 5,
    } as Partial<OverrideRule> as OverrideRule;

    cy.mount(
      <Wrapper>
        <OverrideRuleModal
          rule={rule}
          radarrServices={[]}
          sonarrServices={sonarrServices}
          onClose={() => {}}
        />
      </Wrapper>
    );

    cy.wait('@sonarrTest');
    cy.get('#rootFolderRule').should('not.be.disabled');
    cy.get('#profileIdRule').should('not.be.disabled');
  });

  it('populates root folder and quality profile options after service resolves', () => {
    const radarrServices = [
      {
        id: 3,
        name: 'Radarr',
        hostname: 'localhost',
        port: 7878,
        apiKey: 'test',
      },
    ] as RadarrSettings[];
    const rule = {
      radarrServiceId: 3,
    } as Partial<OverrideRule> as OverrideRule;

    cy.mount(
      <Wrapper>
        <OverrideRuleModal
          rule={rule}
          radarrServices={radarrServices}
          sonarrServices={[]}
          onClose={() => {}}
        />
      </Wrapper>
    );

    cy.wait('@radarrTest');
    cy.get('#rootFolderRule').should('contain', '/movies');
    cy.get('#profileIdRule').should('contain', 'HD-1080p');
  });

  it('keeps dropdowns disabled when no service is selected', () => {
    cy.mount(
      <Wrapper>
        <OverrideRuleModal
          rule={null}
          radarrServices={[]}
          sonarrServices={[]}
          onClose={() => {}}
        />
      </Wrapper>
    );

    cy.get('#rootFolderRule').should('be.disabled');
    cy.get('#profileIdRule').should('be.disabled');
  });
});
