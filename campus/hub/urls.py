from django.urls import path
from . import api
from . import companion_bridge

urlpatterns = [path('api/hub/companion-bridge',companion_bridge.endpoint), path('api/hub/<path:route>',api.endpoint), path('hub/',api.workbench),
               path('hub/assets/<str:name>',api.client_file)]
